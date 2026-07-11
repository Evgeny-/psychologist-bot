import type { Api } from 'grammy';
import { createLLMProvider, createAllLLMProviders, type LLMProvider, type LLMUsage } from '../providers/llm/index.js';
import { getDailySystemPrompt } from '../prompts/daily.js';
import { todayLocal, shiftLocalDate } from '../utils/date.js';
import { config } from '../config.js';
import { t } from '../i18n/index.js';
import { sendRawHtmlMessages, markdownToHtml } from '../utils/telegram.js';
import { queries } from '../db/index.js';
import { sendAudioReply } from './audio-replies.js';
import { buildSystemPromptWithUserMemory, sanitizeDailyMemorySummary } from './memory-context.js';
import { buildPatternContextBlock } from './patterns.js';
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

interface ExperimentSignal {
  relevant?: boolean;
  counted?: boolean;
  note?: string;
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
  experiment?: ExperimentSignal | null;
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

function saveAnalysis(entryId: number, response: ParsedAnalysisResponse, llm: LLMProvider): ExtractedMetrics {
  const { parsed, freeform, metrics } = response;

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

/**
 * If the analysis marked the active experiment as counted, record the event and
 * bump progress. Must run at most once per entry (first successful provider);
 * the UNIQUE(experiment_id, entry_id) index backstops re-processing — a duplicate
 * insert throws, lands in the catch below, and progress is not incremented.
 */
function applyExperimentResult(entryId: number, parsed: AnalysisResult | null): boolean {
  const experiment = parsed?.experiment;
  if (!experiment?.counted) return false;
  try {
    const active = queries.getActiveExperiment();
    if (!active) return false;
    queries.insertExperimentEvent({
      experiment_id: active.id,
      entry_id: entryId,
      note: typeof experiment.note === 'string' ? experiment.note : undefined,
    });
    queries.incrementExperimentProgress(active.id);
    logInfo('experiment.event.counted', {
      entryId,
      experimentId: active.id,
      progress: active.progress_count + 1,
      target: active.target_count,
    });
    return true;
  } catch (err) {
    logWarn('experiment.event.failed', { entryId, reason: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function formatUsage(usage?: LLMUsage): string {
  if (!usage) return '';
  return ` | ${usage.inputTokens}in/${usage.outputTokens}out | $${usage.costUsd.toFixed(5)}`;
}

function formatMetricsLine(metrics: ExtractedMetrics): string {
  const parts: string[] = [];
  if (metrics.mood !== undefined) parts.push(`настроение: ${metrics.mood}`);
  if (metrics.anxiety !== undefined) parts.push(`тревога: ${metrics.anxiety}`);
  if (metrics.stress !== undefined) parts.push(`стресс: ${metrics.stress}`);
  if (metrics.productivity !== undefined) parts.push(`продуктивность: ${metrics.productivity}`);
  if (metrics.routine !== undefined) parts.push(`рутина: ${metrics.routine}`);
  if (parts.length === 0) return '';
  return `\n<blockquote>📊 ${parts.join(' | ')}</blockquote>`;
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

function buildActiveExperimentBlock(): string | null {
  try {
    const active = queries.getActiveExperiment();
    if (!active) return null;
    const target = active.target_count ?? '—';
    const criterion = active.success_criterion ?? '—';
    return config.language === 'ru'
      ? `--- АКТИВНЫЙ ЭКСПЕРИМЕНТ НЕДЕЛИ: ${active.text}. Критерий: ${criterion}. Прогресс: ${active.progress_count}/${target} ---`
      : `--- ACTIVE WEEKLY EXPERIMENT: ${active.text}. Criterion: ${criterion}. Progress: ${active.progress_count}/${target} ---`;
  } catch (err) {
    logWarn('analysis.context.experiment_failed', { reason: err instanceof Error ? err.message : String(err) });
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

  const sections: string[] = [];

  const experimentBlock = buildActiveExperimentBlock();
  if (experimentBlock) sections.push(experimentBlock);

  const intentionsBlock = buildYesterdayIntentionsBlock(yesterday);
  if (intentionsBlock) sections.push(intentionsBlock);

  const patternBlock = buildPatternContextBlock(config.language);
  if (patternBlock) sections.push(patternBlock);

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
      .map((e, i) => `[Вчерашняя запись ${i + 1}]\n${e.transcript || e.raw_text || ''}`)
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
  const experimentCounted = applyExperimentResult(entryId, parsedResponse.parsed);

  // Save analysis as assistant message in thread
  const freeform = parsedResponse.freeform;
  queries.insertThreadMessage({
    thread_id: threadId,
    role: 'assistant',
    content: freeform,
    llm_provider: llm.providerName,
    llm_model: llm.modelName,
  });

  const costInfo = result.usage ? ` | $${result.usage.costUsd.toFixed(5)}` : '';
  const meta = `<blockquote>${t().analysisHeader}${costInfo}</blockquote>`;
  const body = markdownToHtml(freeform);
  const metricsLine = formatMetricsLine(metrics);
  await sendRawHtmlMessages(api, chatId, `${meta}\n\n${body}${metricsLine}`, replyToMessageId);
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
    experimentCounted,
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
      // Experiment progress is counted only once per entry (first successful provider).
      if (!threadSaved) {
        const dailyMemorySaved = saveDailyMemorySummary(entryDate, entryId, parsedResponse.parsed, llm);
        const experimentCounted = applyExperimentResult(entryId, parsedResponse.parsed);
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
          experimentCounted,
        });
      }
      const meta = `<blockquote>${label} | ${elapsed}s${formatUsage(result.usage)}</blockquote>`;
      const body = markdownToHtml(freeform);
      const metricsLine = formatMetricsLine(metrics);
      await sendRawHtmlMessages(api, chatId, `${meta}\n\n${body}${metricsLine}`, replyToMessageId);
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
