import type { Api, InlineKeyboard } from 'grammy';
import { createLLMProvider, createAllLLMProviders, type LLMProvider, type LLMUsage } from '../providers/llm/index.js';
import { getDailySystemPrompt } from '../prompts/daily.js';
import { todayLocal, shiftLocalDate, mondayOfWeek } from '../utils/date.js';
import { config } from '../config.js';
import { t } from '../i18n/index.js';
import { sendRawHtmlMessages, markdownToHtml } from '../utils/telegram.js';
import { contractKeyboard } from '../utils/callbacks.js';
import { queries } from '../db/index.js';
import { sendAudioReply } from './audio-replies.js';
import { buildSystemPromptWithUserMemory, sanitizeDailyMemorySummary } from './memory-context.js';
import { buildPatternContextBlock } from './patterns.js';
import { buildOrbitContextBlock } from './orbits.js';
import { isOrbitThemeKey } from '../prompts/orbits.js';
import { findSimilarEpisodes, embedEntryText, computeEntryVector, storeEntryVector } from './similarity.js';
import { parseJsonResponse, stripJsonBlock } from '../utils/json.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';

interface ThoughtRecord {
  thought?: string;
  distortion?: string;
  evidence_for?: string[];
  evidence_against?: string[];
  alternative?: string;
  belief_question?: string;
}

interface ContractSignal {
  done?: boolean;
  named?: string;
  note?: string;
}

interface LabelReviewSignal {
  verdict?: 'yes' | 'no' | 'partly';
  note?: string;
}

interface SlotSignal {
  text?: string;
  when?: string;
  who?: string;
  cost?: string;
}

interface AnalysisResult {
  sentiment?: string;
  emotions?: string[];
  triggers?: string[];
  wins?: string[];
  distortions?: Array<{ type: string; quote: string; reframe: string }>;
  gratitude?: string[];
  action_items?: string[];
  topics?: string[];
  orbit_themes?: string[];
  gratitude_count?: number;
  metrics?: {
    mood?: number | null;
    anxiety?: number | null;
    stress?: number | null;
    productivity?: number | null;
    routine?: number | null;
  };
  daily_memory_summary?: string;
  thought_record?: ThoughtRecord | null;
  contract?: ContractSignal | null;
  label_review?: LabelReviewSignal | null;
  credits?: string[];
  slot?: SlotSignal | null;
  closing_question?: string | null;
  analysis_text?: string;
  reply_audio_requested?: boolean;
}

export interface ExtractedMetrics {
  mood?: number;
  anxiety?: number;
  stress?: number;
  productivity?: number;
  routine?: number;
}

interface ParsedAnalysisResponse {
  parsed: AnalysisResult | null;
  freeform: string;
  metrics: ExtractedMetrics;
  wantsAudioReply: boolean;
  parsedJson: boolean;
}

function extractFreeformAnalysis(text: string, parsed: AnalysisResult | null): string {
  if (typeof parsed?.analysis_text === 'string' && parsed.analysis_text.trim()) {
    return parsed.analysis_text.trim();
  }
  const afterJson = stripJsonBlock(text);
  return afterJson || text;
}

function extractMetrics(parsed: AnalysisResult | null): ExtractedMetrics {
  const m = parsed?.metrics;
  if (!m) return {};
  const result: ExtractedMetrics = {};
  if (typeof m.mood === 'number' && m.mood >= 0 && m.mood <= 10) result.mood = m.mood;
  if (typeof m.anxiety === 'number' && m.anxiety >= 0 && m.anxiety <= 10) result.anxiety = m.anxiety;
  if (typeof m.stress === 'number' && m.stress >= 0 && m.stress <= 10) result.stress = m.stress;
  if (typeof m.productivity === 'number' && m.productivity >= 0 && m.productivity <= 10) result.productivity = m.productivity;
  if (typeof m.routine === 'number' && m.routine >= 0 && m.routine <= 10) result.routine = m.routine;
  return result;
}

function parseAnalysisResponse(responseText: string): ParsedAnalysisResponse {
  const parsed = parseJsonResponse<AnalysisResult>(responseText);
  const freeform = extractFreeformAnalysis(responseText, parsed);
  const metrics = extractMetrics(parsed);

  return {
    parsed,
    freeform,
    metrics,
    wantsAudioReply: parsed?.reply_audio_requested === true,
    parsedJson: parsed !== null,
  };
}

/** Keep only known taxonomy keys (the model occasionally invents labels), max 3. */
function sanitizeOrbitThemes(themes: unknown): string[] {
  if (!Array.isArray(themes)) return [];
  return themes.filter(isOrbitThemeKey).slice(0, 3);
}

function saveAnalysis(entryId: number, response: ParsedAnalysisResponse, llm: LLMProvider): ExtractedMetrics {
  const { parsed, freeform, metrics } = response;
  const orbitThemes = sanitizeOrbitThemes(parsed?.orbit_themes);

  queries.insertAnalysis({
    entry_id: entryId,
    analysis_text: freeform,
    sentiment: parsed?.sentiment,
    distortions_json: parsed?.distortions?.length ? JSON.stringify(parsed.distortions) : undefined,
    topics_json: parsed?.topics?.length ? JSON.stringify(parsed.topics) : undefined,
    action_items_json: parsed?.action_items?.length ? JSON.stringify(parsed.action_items) : undefined,
    emotions_json: parsed?.emotions?.length ? JSON.stringify(parsed.emotions) : undefined,
    triggers_json: parsed?.triggers?.length ? JSON.stringify(parsed.triggers) : undefined,
    wins_json: parsed?.wins?.length ? JSON.stringify(parsed.wins) : undefined,
    orbit_themes_json: orbitThemes.length ? JSON.stringify(orbitThemes) : undefined,
    closing_question: typeof parsed?.closing_question === 'string' && parsed.closing_question.trim()
      ? parsed.closing_question.trim()
      : undefined,
    gratitude_count: parsed?.gratitude_count ?? parsed?.gratitude?.length ?? 0,
    llm_provider: llm.providerName,
    llm_model: llm.modelName,
  });

  return metrics;
}

function saveDailyMemorySummary(date: string, entryId: number, parsed: AnalysisResult | null, llm: LLMProvider): boolean {
  if (typeof parsed?.daily_memory_summary !== 'string') return false;
  const summary = sanitizeDailyMemorySummary(parsed.daily_memory_summary);
  if (!summary) return false;

  queries.upsertDailyMemory({
    date,
    summary,
    source_entry_id: entryId,
    llm_provider: llm.providerName,
    llm_model: llm.modelName,
  });
  return true;
}

const LABEL_DISTORTION_MARKERS = ['ярлык', 'label'];

/** Distortions whose type is a label ("навешивание ярлыков"), which are the ones worth re-reading in the morning. */
function extractLabelQuotes(parsed: AnalysisResult | null): string[] {
  if (!Array.isArray(parsed?.distortions)) return [];
  return parsed.distortions
    .filter((d) => {
      const type = typeof d?.type === 'string' ? d.type.toLowerCase() : '';
      return LABEL_DISTORTION_MARKERS.some((m) => type.includes(m));
    })
    .map((d) => (typeof d?.quote === 'string' ? d.quote.trim() : ''))
    .filter((q) => q.length > 0 && q.length <= 300)
    .slice(0, 2);
}

/**
 * Persist the behavioural signals the analysis extracted: the day's contract, the
 * morning label verdict, external credits, a newly named slot, and any fresh labels
 * held over for tomorrow.
 *
 * Runs at most once per entry (first successful provider) so compare mode does not
 * double-count. Every branch is fail-soft: a broken signal must never cost the user
 * their analysis reply.
 */
function applyDailySignals(entryId: number, date: string, parsed: AnalysisResult | null): { contractCounted: boolean } {
  let contractCounted = false;
  if (!parsed) return { contractCounted };

  // Contract: only a positive verdict is written straight away. A "not yet" early in the
  // day must not close the day — the nightly sweep marks genuinely unanswered days missed.
  try {
    const contract = parsed.contract;
    if (contract?.done === true) {
      const existing = queries.getContract(date);
      if (existing && existing.status !== 'done') {
        queries.resolveContract(date, {
          status: 'done',
          note: typeof contract.named === 'string' ? contract.named : contract.note,
          entry_id: entryId,
        });
        contractCounted = true;
        logInfo('contract.counted', { entryId, date, named: contract.named });
      }
    } else if (typeof contract?.named === 'string' && contract.named.trim()) {
      const existing = queries.getContract(date);
      if (existing && !existing.text) queries.setContractText(date, contract.named.trim());
    }
  } catch (err) {
    logWarn('contract.apply_failed', { entryId, reason: err instanceof Error ? err.message : String(err) });
  }

  // Label review: yesterday's verdict, answered this morning or later in the day.
  try {
    const verdict = parsed.label_review?.verdict;
    if (verdict === 'yes' || verdict === 'no' || verdict === 'partly') {
      const pending = queries.getLabelForReview(shiftLocalDate(date, -1)) ?? queries.getLabelForReview(date);
      if (pending) {
        queries.reviewLabel(pending.id, verdict);
        logInfo('label.reviewed', { entryId, labelId: pending.id, verdict });
      }
    }
  } catch (err) {
    logWarn('label.review_failed', { entryId, reason: err instanceof Error ? err.message : String(err) });
  }

  // External credits: proof sourced from someone other than him.
  try {
    const credits = Array.isArray(parsed.credits) ? parsed.credits : [];
    for (const credit of credits.slice(0, 5)) {
      if (typeof credit !== 'string') continue;
      const text = credit.trim();
      if (!text) continue;
      queries.insertCredit({ entry_id: entryId, date, text: text.slice(0, 500) });
    }
    if (credits.length) logInfo('credits.recorded', { entryId, count: credits.length });
  } catch (err) {
    logWarn('credits.apply_failed', { entryId, reason: err instanceof Error ? err.message : String(err) });
  }

  // Slot: a commitment that already costs a date, money or another person.
  try {
    const slot = parsed.slot;
    const text = typeof slot?.text === 'string' ? slot.text.trim() : '';
    if (text) {
      const open = queries.getOpenSlot();
      if (!open || open.text.trim() !== text) {
        const id = queries.insertSlot({
          week_start: mondayOfWeek(date),
          text: text.slice(0, 300),
          when_at: typeof slot?.when === 'string' ? slot.when : undefined,
          who: typeof slot?.who === 'string' ? slot.who : undefined,
          cost: typeof slot?.cost === 'string' ? slot.cost : undefined,
        });
        logInfo('slot.recorded', { entryId, slotId: id });
      }
    }
  } catch (err) {
    logWarn('slot.apply_failed', { entryId, reason: err instanceof Error ? err.message : String(err) });
  }

  // Fresh labels, stored verbatim for tomorrow morning's review.
  try {
    const entryTime = queries.getEntryById(entryId)?.local_time ?? undefined;
    for (const quote of extractLabelQuotes(parsed)) {
      queries.insertLabel({ entry_id: entryId, date, said_at: entryTime, quote });
    }
  } catch (err) {
    logWarn('label.capture_failed', { entryId, reason: err instanceof Error ? err.message : String(err) });
  }

  return { contractCounted };
}

function formatUsage(usage?: LLMUsage): string {
  if (!usage) return '';
  return ` | ${usage.inputTokens}in/${usage.outputTokens}out | $${usage.costUsd.toFixed(5)}`;
}

const escapeTg = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatMetricsLine(metrics: ExtractedMetrics): string {
  const short = t().metricShort;
  const parts: Array<[string, number]> = [];
  if (metrics.mood !== undefined) parts.push([short.mood, metrics.mood]);
  if (metrics.anxiety !== undefined) parts.push([short.anxiety, metrics.anxiety]);
  if (metrics.stress !== undefined) parts.push([short.stress, metrics.stress]);
  if (metrics.productivity !== undefined) parts.push([short.productivity, metrics.productivity]);
  if (metrics.routine !== undefined) parts.push([short.routine, metrics.routine]);
  if (parts.length === 0) return '';
  // Monospace so the numbers line up under each other across days.
  return `<pre>${parts.map(([k, v]) => `${k} ${v}`).join('   ')}</pre>`;
}

/** The one line he actually asked for: was the behaviour credited, and for what. */
function formatCredit(parsed: AnalysisResult | null): string {
  const contract = parsed?.contract;
  if (contract?.done !== true) return '';
  const what = typeof contract.named === 'string' ? contract.named.trim() : '';
  const label = t().creditedLabel;
  if (!what) return `<b>${label}</b>`;
  return `<b>${label}:</b> ${escapeTg(what)}`;
}

/**
 * Distortions with their quotes and reframes.
 *
 * The model has been producing these on every entry since March and they were written straight
 * to SQLite and never rendered — the chat only ever saw the prose. This is the material he asked
 * for six separate times in threads ("добавь деталей", "детальнее плиз").
 */
function formatDistortions(parsed: AnalysisResult | null): string {
  const items = (parsed?.distortions ?? []).filter(
    (d) => d && typeof d.quote === 'string' && d.quote.trim() && typeof d.reframe === 'string' && d.reframe.trim(),
  );
  if (items.length === 0) return '';

  const body = items
    .slice(0, 5)
    .map((d) => {
      const type = typeof d.type === 'string' && d.type.trim() ? ` <i>${escapeTg(d.type.trim())}</i>` : '';
      return `<blockquote>${escapeTg(d.quote.trim())}</blockquote>${type}\n${escapeTg(d.reframe.trim())}`;
    })
    .join('\n\n');
  return `<b>${t().thoughtsOfDayHeader} — ${items.length}</b>\n${body}`;
}

/**
 * The one question the evening message may carry, and only when the answer is genuinely missing.
 *
 * The contract used to be asked every single morning, unconditionally, as a task for the day —
 * which made it the most reliably ignored line the bot produced. It is now read out of what he
 * already said: `applyDailySignals` resolves it from the transcript, and the buttons appear only
 * on the days the transcript did not say either way. Telegram draws the keyboard under the whole
 * message, so the question is appended last, alone.
 */
function buildContractAsk(date: string): { text: string; keyboard: InlineKeyboard } | null {
  try {
    const contract = queries.getContract(date);
    if (!contract || contract.status !== 'open') return null;
    return { text: t().contractAsk, keyboard: contractKeyboard(date) };
  } catch (err) {
    logWarn('analysis.contract_ask_failed', { date, reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Compose the evening reply.
 *
 * Order is deliberate: the credit goes first because it is the only thing that shows up in the
 * notification preview, and it is the single element he named as missing ("чтобы меня засчитывали").
 * No collapsing anywhere — he said he would expand everything or read nothing, so hiding content
 * only costs a tap. Every analysis in the corpus fits one message even fully expanded.
 */
export function renderAnalysisMessage(
  freeform: string,
  parsed: AnalysisResult | null,
  metrics: ExtractedMetrics,
): string {
  const blocks = [
    formatCredit(parsed),
    markdownToHtml(freeform),
    formatDistortions(parsed),
    formatMetricsLine(metrics),
  ].filter((b) => b.trim());
  return blocks.join('\n\n');
}

function getYesterdayDate(date: string): string {
  return shiftLocalDate(date, -1);
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

/**
 * The day's contract, if one is open. Deliberately identical every day: the value is in
 * the binary answer accumulating into a streak, not in the wording being fresh.
 */
function buildContractBlock(date: string): string | null {
  try {
    const contract = queries.getContract(date);
    if (!contract) return null;
    const named = contract.text ? (config.language === 'ru' ? ` Назвал утром: ${contract.text}.` : ` Named in the morning: ${contract.text}.`) : '';
    if (contract.status === 'done') {
      return config.language === 'ru'
        ? `--- КОНТРАКТ ДНЯ: уже засчитан сегодня${named ? '.' + named : '.'} Повторно не засчитывай и не поднимай тему. ---`
        : `--- CONTRACT OF THE DAY: already counted today${named ? '.' + named : '.'} Do not count it again and do not raise it. ---`;
    }
    return config.language === 'ru'
      ? `--- КОНТРАКТ ДНЯ (открыт): один живой контакт с человеком сегодня — звонок, голосовое, сообщение, разговор, прямая просьба.${named} Заполни поле "contract", если из записи видно, был контакт или нет. ---`
      : `--- CONTRACT OF THE DAY (open): one live contact with a person today — a call, a voice note, a text, a conversation, a direct request.${named} Fill the "contract" field if the entry shows whether the contact happened. ---`;
  } catch (err) {
    logWarn('analysis.context.contract_failed', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Yesterday evening's label, verbatim, awaiting a morning verdict. Passed as context only
 * so the model can catch an answer if he gives one — it must not chase him for it.
 */
function buildLabelReviewBlock(date: string): string | null {
  try {
    const pending = queries.getLabelForReview(shiftLocalDate(date, -1));
    if (!pending) return null;
    const at = pending.said_at ? ` в ${pending.said_at}` : '';
    return config.language === 'ru'
      ? `--- ЯРЛЫК НА РЕВИЗИЮ: вчера${at} прозвучало «${pending.quote}». Утром об этом уже спросили. Если пользователь в этой записи так или иначе ответил — заполни "label_review". Если не ответил — null, и НЕ переспрашивай. ---`
      : `--- LABEL FOR REVIEW: yesterday${pending.said_at ? ` at ${pending.said_at}` : ''} he said "${pending.quote}". He was already asked this morning. If he answered in this entry in any way — fill "label_review". If not — null, and do NOT re-ask. ---`;
  } catch (err) {
    logWarn('analysis.context.label_failed', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Questions already asked recently. Repetition is the documented failure mode of this
 * channel: the same recommendation three times does not raise the odds of action, it
 * lowers trust in every message that follows.
 */
function buildAlreadyAskedBlock(): string | null {
  try {
    const questions = queries.getRecentClosingQuestions(10);
    if (questions.length === 0) return null;
    const header = config.language === 'ru'
      ? '--- УЖЕ СПРОШЕНО (не повторяй ни один из этих вопросов — ни дословно, ни по смыслу) ---'
      : '--- ALREADY ASKED (do not repeat any of these — neither verbatim nor in meaning) ---';
    return `${header}\n${questions.map((q) => `- ${q}`).join('\n')}`;
  } catch (err) {
    logWarn('analysis.context.already_asked_failed', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function buildYesterdayIntentionsBlock(yesterday: string): string | null {
  try {
    const items = queries.getActionItemsForDate(yesterday).slice(0, 5);
    if (items.length === 0) return null;
    const header = config.language === 'ru'
      ? '--- ВЧЕРАШНИЕ НАМЕРЕНИЯ (спроси об одном, если уместно) ---'
      : "--- YESTERDAY'S INTENTIONS (ask about one, if fitting) ---";
    return `${header}\n${items.map((i) => `- ${i}`).join('\n')}`;
  } catch (err) {
    logWarn('analysis.context.intentions_failed', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// Exported for the prompt-eval harness (scripts/eval-analysis.ts), which rebuilds
// real prompts against a DB dump.
export async function buildUserPromptWithContext(
  text: string,
  date: string,
  entryId: number,
  entryVector: Float32Array | null,
): Promise<string> {
  const earlier = queries.getEarlierEntriesForDate(date, entryId);
  const yesterday = getYesterdayDate(date);
  const yesterdayEntries = queries.getEntriesByDateRange(yesterday, yesterday);
  // ORBIT_CONTEXT=off lets the eval harness rebuild pre-orbit baseline prompts.
  const orbitContextEnabled = process.env.ORBIT_CONTEXT !== 'off';

  const sections: string[] = [];

  if (orbitContextEnabled) {
    const entryTime = queries.getEntryById(entryId)?.local_time;
    if (entryTime) {
      sections.push(config.language === 'ru'
        ? `[Время записи: ${entryTime}]`
        : `[Entry time: ${entryTime}]`);
    }
  }

  const contractBlock = buildContractBlock(date);
  if (contractBlock) sections.push(contractBlock);

  const labelBlock = buildLabelReviewBlock(date);
  if (labelBlock) sections.push(labelBlock);

  const intentionsBlock = buildYesterdayIntentionsBlock(yesterday);
  if (intentionsBlock) sections.push(intentionsBlock);

  const patternBlock = buildPatternContextBlock(config.language);
  if (patternBlock) sections.push(patternBlock);

  const alreadyAskedBlock = buildAlreadyAskedBlock();
  if (alreadyAskedBlock) sections.push(alreadyAskedBlock);

  if (orbitContextEnabled) {
    const orbitBlock = buildOrbitContextBlock(date, entryId);
    if (orbitBlock) sections.push(orbitBlock);
  }

  const similarBlock = entryVector
    ? await withTimeout(
        findSimilarEpisodes(text, { excludeEntryId: entryId, queryVec: entryVector }),
        4000,
        null,
      )
    : null;
  if (similarBlock) sections.push(similarBlock);

  let yesterdayBlock: string | null = null;
  if (yesterdayEntries.length > 0) {
    const yesterdayTranscripts = yesterdayEntries
      .map((e, i) => `[${config.language === 'ru' ? 'Вчерашняя запись' : 'Yesterday entry'} ${i + 1}]\n${e.transcript || e.raw_text || ''}`)
      .join('\n\n---\n\n');
    yesterdayBlock = config.language === 'ru'
      ? `--- КОНТЕКСТ: записи ЗА ВЧЕРА (только для фоновой связи мыслей, НЕ анализируй их, НЕ упоминай явно) ---\n\n${yesterdayTranscripts}\n\n--- КОНЕЦ ВЧЕРАШНЕГО КОНТЕКСТА ---`
      : `--- BACKGROUND CONTEXT: yesterday's entries (for continuity only — do NOT analyze them, do NOT reference them explicitly) ---\n\n${yesterdayTranscripts}\n\n--- END YESTERDAY CONTEXT ---`;
  }

  let earlierBlock: string | null = null;
  if (earlier.length > 0) {
    const contextParts = earlier.map((e, i) => {
      const entryText = e.transcript || e.raw_text || '';
      let part = `[Earlier entry ${i + 1}]\n${entryText}`;
      if (e.analysis_text) {
        part += `\n\n[Your previous analysis]\n${e.analysis_text}`;
      }
      return part;
    });
    earlierBlock = config.language === 'ru'
      ? `--- КОНТЕКСТ: предыдущие записи за сегодня (только для справки, НЕ анализируй их повторно) ---\n\n${contextParts.join('\n\n---\n\n')}\n\n--- ТЕКУЩАЯ ЗАПИСЬ (анализируй именно её) ---`
      : `--- CONTEXT: earlier entries from today (for reference only, do NOT re-analyze them) ---\n\n${contextParts.join('\n\n---\n\n')}\n\n--- CURRENT ENTRY (analyze this one) ---`;
  }

  if (yesterdayBlock) {
    const estimatedTotal = text.length + yesterdayBlock.length + (earlierBlock?.length ?? 0);
    if (estimatedTotal <= 100_000) {
      sections.push(yesterdayBlock);
    }
  }

  if (earlierBlock) sections.push(earlierBlock);

  if (sections.length === 0) return text;

  return sections.join('\n\n') + '\n\n' + text;
}

export async function analyzeEntry(
  api: Api,
  chatId: number,
  entryId: number,
  text: string,
  threadId: number,
  replyToMessageId?: number,
  date?: string,
): Promise<ExtractedMetrics> {
  const entryDate = date || todayLocal();
  const systemPrompt = buildSystemPromptWithUserMemory(
    getDailySystemPrompt(config.language),
    entryDate,
    { includeReferenceDate: false },
  );
  // One embedding call per entry: the same vector serves the similarity lookup below
  // and is persisted afterwards for future lookups.
  const entryVector = await withTimeout(
    computeEntryVector(text).catch((err) => {
      logWarn('similarity.embed_failed', { entryId, reason: err instanceof Error ? err.message : String(err) });
      return null;
    }),
    4000,
    null,
  );
  const userPrompt = await buildUserPromptWithContext(text, entryDate, entryId, entryVector);

  if (entryVector) {
    try {
      storeEntryVector(entryId, entryVector);
    } catch (err) {
      logWarn('similarity.store_failed', { entryId, reason: err instanceof Error ? err.message : String(err) });
    }
  } else {
    // Vector unavailable (timeout / transient error): retry in the background so the
    // entry still becomes searchable later.
    embedEntryText(entryId, text).catch((err) => {
      logWarn('similarity.embed_failed', { entryId, reason: err instanceof Error ? err.message : String(err) });
    });
  }

  // Save user's diary entry as first thread message
  queries.insertThreadMessage({
    thread_id: threadId,
    role: 'user',
    content: text,
  });
  logInfo('llm.analysis.start', {
    chatId,
    entryId,
    threadId,
    replyToMessageId,
    entryDate,
    inputChars: text.length,
    promptChars: userPrompt.length,
    systemChars: systemPrompt.length,
    compareMode: config.compareMode,
  });

  if (config.compareMode) {
    return analyzeCompare(api, chatId, entryId, entryDate, userPrompt, systemPrompt, threadId, replyToMessageId);
  }

  const llm = createLLMProvider();
  const start = Date.now();
  const result = await llm.analyze(userPrompt, systemPrompt);
  const parsedResponse = parseAnalysisResponse(result.text);
  if (!parsedResponse.parsedJson) {
    logWarn('llm.analysis.parse_fallback', {
      chatId,
      entryId,
      threadId,
      provider: llm.providerName,
      model: llm.modelName,
      outputChars: result.text.length,
    });
  }

  const metrics = saveAnalysis(entryId, parsedResponse, llm);
  const dailyMemorySaved = saveDailyMemorySummary(entryDate, entryId, parsedResponse.parsed, llm);
  const { contractCounted } = applyDailySignals(entryId, entryDate, parsedResponse.parsed);

  // Save analysis as assistant message in thread
  const freeform = parsedResponse.freeform;
  queries.insertThreadMessage({
    thread_id: threadId,
    role: 'assistant',
    content: freeform,
    llm_provider: llm.providerName,
    llm_model: llm.modelName,
  });

  // No technical header: it used to occupy the first line, which is the only part visible in
  // the notification preview, and spent it on the cost of the API call.
  const contractAsk = buildContractAsk(entryDate);
  const rendered = renderAnalysisMessage(freeform, parsedResponse.parsed, metrics);
  const outgoing = contractAsk ? `${rendered}\n\n${contractAsk.text}` : rendered;
  await sendRawHtmlMessages(api, chatId, outgoing, replyToMessageId, { keyboard: contractAsk?.keyboard });
  logInfo('llm.analysis.complete', {
    chatId,
    entryId,
    threadId,
    replyToMessageId,
    provider: llm.providerName,
    model: llm.modelName,
    elapsedMs: Date.now() - start,
    outputChars: freeform.length,
    parsedJson: parsedResponse.parsedJson,
    wantsAudioReply: parsedResponse.wantsAudioReply,
    metricsExtracted: Object.keys(metrics).length,
    dailyMemorySaved,
    thoughtRecord: !!parsedResponse.parsed?.thought_record,
    closingQuestion: !!parsedResponse.parsed?.closing_question,
    contractCounted,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    costUsd: result.usage?.costUsd?.toFixed(5),
  });

  if (parsedResponse.wantsAudioReply) {
    await sendAudioReply(api, chatId, freeform, replyToMessageId).catch(async (err) => {
      logError('tts.reply.failed', err, { chatId, entryId, threadId, replyToMessageId });
      await sendRawHtmlMessages(api, chatId, t().audioReplyUnavailable, replyToMessageId).catch(() => {});
    });
  }
  return metrics;
}

async function analyzeCompare(
  api: Api,
  chatId: number,
  entryId: number,
  entryDate: string,
  text: string,
  systemPrompt: string,
  threadId: number,
  replyToMessageId?: number,
): Promise<ExtractedMetrics> {
  const providers = createAllLLMProviders();

  const results = await Promise.allSettled(
    providers.map(async (llm) => {
      const start = Date.now();
      const result = await llm.analyze(text, systemPrompt);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      return { result, llm, elapsed };
    }),
  );

  let threadSaved = false;
  let firstMetrics: ExtractedMetrics = {};
  let audioSent = false;

  for (let i = 0; i < results.length; i++) {
    const settled = results[i];
    const provider = providers[i];
    const label = `${provider.providerName} (${provider.modelName})`;

    if (settled.status === 'fulfilled') {
      const { result, llm, elapsed } = settled.value;
      const parsedResponse = parseAnalysisResponse(result.text);
      if (!parsedResponse.parsedJson) {
        logWarn('llm.analysis.compare_parse_fallback', {
          chatId,
          entryId,
          threadId,
          provider: llm.providerName,
          model: llm.modelName,
          outputChars: result.text.length,
        });
      }
      const metrics = saveAnalysis(entryId, parsedResponse, llm);

      if (!threadSaved) {
        firstMetrics = metrics;
      }

      const freeform = parsedResponse.freeform;

      // Save first successful provider's response as thread context for follow-up chat.
      // Behavioural signals are recorded only once per entry (first successful provider).
      if (!threadSaved) {
        const dailyMemorySaved = saveDailyMemorySummary(entryDate, entryId, parsedResponse.parsed, llm);
        const { contractCounted } = applyDailySignals(entryId, entryDate, parsedResponse.parsed);
        queries.insertThreadMessage({
          thread_id: threadId,
          role: 'assistant',
          content: freeform,
          llm_provider: llm.providerName,
          llm_model: llm.modelName,
        });
        threadSaved = true;
        logInfo('daily_memory.compare_saved', {
          entryId,
          threadId,
          provider: llm.providerName,
          model: llm.modelName,
          saved: dailyMemorySaved,
          contractCounted,
        });
      }
      const meta = `<blockquote>${label} | ${elapsed}s${formatUsage(result.usage)}</blockquote>`;
      const rendered = renderAnalysisMessage(freeform, parsedResponse.parsed, metrics);
      await sendRawHtmlMessages(api, chatId, `${meta}\n\n${rendered}`, replyToMessageId);
      logInfo('llm.analysis.compare_complete', {
        chatId,
        entryId,
        threadId,
        replyToMessageId,
        provider: llm.providerName,
        model: llm.modelName,
        elapsedSec: elapsed,
        outputChars: freeform.length,
        parsedJson: parsedResponse.parsedJson,
        wantsAudioReply: parsedResponse.wantsAudioReply,
        metricsExtracted: Object.keys(metrics).length,
        thoughtRecord: !!parsedResponse.parsed?.thought_record,
        closingQuestion: !!parsedResponse.parsed?.closing_question,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        costUsd: result.usage?.costUsd?.toFixed(5),
      });

      if (parsedResponse.wantsAudioReply && !audioSent) {
        await sendAudioReply(api, chatId, freeform, replyToMessageId).catch(async (err) => {
          logError('tts.reply.failed', err, { chatId, entryId, threadId, replyToMessageId });
          await sendRawHtmlMessages(api, chatId, t().audioReplyUnavailable, replyToMessageId).catch(() => {});
        });
        audioSent = true;
      }
    } else {
      const errMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      logError('llm.analysis.compare_failed', settled.reason, {
        chatId,
        entryId,
        threadId,
        replyToMessageId,
        provider: provider.providerName,
        model: provider.modelName,
      });
      await sendRawHtmlMessages(api, chatId, `<blockquote>${label}</blockquote>\n\nError: ${errMsg}`, replyToMessageId);
    }
  }

  return firstMetrics;
}
