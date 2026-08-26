import type { Api, InlineKeyboard } from 'grammy';
import { createLLMProvider, createAllLLMProviders, type LLMProvider } from '../providers/llm/index.js';
import { getWeeklySystemPrompt } from '../prompts/weekly.js';
import { getMonthlySystemPrompt } from '../prompts/monthly.js';
import { getMorningSystemPrompt } from '../prompts/morning.js';
import { config } from '../config.js';
import { t } from '../i18n/index.js';
import { queries } from '../db/index.js';
import type { MetricsRow } from '../db/queries.js';
import { sendSplitMessages, sendRawHtmlMessages, markdownToHtml, postChannelHeader, escapeHtml } from '../utils/telegram.js';
import { creditKeyboard, labelKeyboard } from '../utils/callbacks.js';
import { formatDateLocal, shiftLocalDate, todayLocal } from '../utils/date.js';
import { averageMetric, formatCompactNumber } from '../utils/format.js';
import { parseJsonResponse, stripJsonBlock } from '../utils/json.js';
import { getMemoryUpdatePrompt, MEMORY_MAX_LENGTH } from '../prompts/memory.js';
import { sendMetricsChart } from './charts.js';
import { getDistortionCounts, getDistortionCountsByRange } from './patterns.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';

// ~400k chars ≈ 100k tokens — keeps us under Sonnet's 200k limit with room for system prompt + response
const MAX_CONTEXT_CHARS = 400_000;

// Get Monday of the current week
function getMonday(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Sunday → -6, else 1 - day
  date.setDate(date.getDate() + diff);
  return date;
}

interface ThreadMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface DaySummary {
  date: string;
  transcript: string | null;
  llmResponse: string | null;
  threadFollowUp: ThreadMessage[] | null;
  metrics: string | null;
}

interface MorningCredit {
  quote?: string | null;
  skill?: string | null;
  counter?: string | null;
}

interface MorningBriefEnvelope {
  credit?: MorningCredit | null;
  note?: string | null;
  skip?: boolean;
}

interface WeeklySlotVerdict {
  status?: 'kept' | 'missed';
  note?: string;
}

interface WeeklyReportEnvelope {
  report_text?: string;
  slot_verdict?: WeeklySlotVerdict | null;
}

function buildDaySummaries(start: string, end: string): DaySummary[] {
  const entries = queries.getEntriesByDateRange(start, end);
  const metrics = queries.getMetricsByDateRange(start, end);

  const threadIds = entries.map((e) => e.telegram_message_id);
  const allThreadMessages = queries.getAllThreadMessages(threadIds);

  const summaries: DaySummary[] = [];

  for (const entry of entries) {
    const transcript = entry.transcript || entry.raw_text || null;
    const messages = allThreadMessages.get(entry.telegram_message_id) ?? [];

    // First assistant message is the initial LLM analysis
    const firstAssistantIdx = messages.findIndex((m) => m.role === 'assistant');
    const llmResponse = firstAssistantIdx >= 0 ? messages[firstAssistantIdx].content : null;

    // Everything after the first assistant message is follow-up conversation
    let threadFollowUp: ThreadMessage[] | null = null;
    if (firstAssistantIdx >= 0 && firstAssistantIdx < messages.length - 1) {
      threadFollowUp = messages.slice(firstAssistantIdx + 1).map((m) => ({
        role: m.role,
        content: m.content,
      }));
    }

    const dayMetrics = metrics.find((m) => m.date === entry.date);
    let metricsStr: string | null = null;
    if (dayMetrics) {
      const m: string[] = [];
      if (dayMetrics.mood !== null) m.push(`mood=${dayMetrics.mood}`);
      if (dayMetrics.anxiety !== null) m.push(`anxiety=${dayMetrics.anxiety}`);
      if (dayMetrics.stress !== null) m.push(`stress=${dayMetrics.stress}`);
      if (dayMetrics.productivity !== null) m.push(`productivity=${dayMetrics.productivity}`);
      if (dayMetrics.routine !== null) m.push(`routine=${dayMetrics.routine}`);
      if (m.length) metricsStr = m.join(', ');
    }

    summaries.push({ date: entry.date, transcript, llmResponse, threadFollowUp, metrics: metricsStr });
  }

  return summaries;
}

function formatThreadFollowUp(messages: ThreadMessage[]): string {
  return messages.map((m) => {
    const label = m.role === 'user' ? 'User' : 'Assistant';
    return `${label}:\n${m.content}`;
  }).join('\n\n');
}

function formatSummariesFull(summaries: DaySummary[]): string {
  return summaries.map((s) => {
    const parts = [`[${s.date}]`];
    if (s.transcript) parts.push(`Transcript:\n${s.transcript}`);
    if (s.llmResponse) parts.push(`LLM Analysis:\n${s.llmResponse}`);
    if (s.threadFollowUp) parts.push(`Follow-up Conversation:\n${formatThreadFollowUp(s.threadFollowUp)}`);
    if (s.metrics) parts.push(`Metrics: ${s.metrics}`);
    return parts.join('\n\n');
  }).join('\n\n---\n\n');
}

function formatSummariesCompact(summaries: DaySummary[]): string {
  return summaries.map((s) => {
    const parts = [`[${s.date}]`];
    if (s.llmResponse) parts.push(`LLM Analysis:\n${s.llmResponse}`);
    else if (s.transcript) parts.push(`(transcript available, omitted for brevity)`);
    if (s.threadFollowUp) parts.push(`Follow-up Conversation:\n${formatThreadFollowUp(s.threadFollowUp)}`);
    if (s.metrics) parts.push(`Metrics: ${s.metrics}`);
    return parts.join('\n\n');
  }).join('\n\n---\n\n');
}

function fitContext(summaries: DaySummary[], maxChars: number): string {
  const full = formatSummariesFull(summaries);
  if (full.length <= maxChars) return full;
  return formatSummariesCompact(summaries);
}

function buildSystemPromptWithMemory(basePrompt: string): string {
  const memory = queries.getMemory();
  if (!memory) return basePrompt;
  const label = config.language === 'ru'
    ? '--- ПАМЯТЬ О ПОЛЬЗОВАТЕЛЕ (используй как контекст, не упоминай явно) ---'
    : '--- USER MEMORY (use as context, do not mention explicitly) ---';
  return `${basePrompt}\n\n${label}\n${memory}\n---`;
}

function parseMorningBriefJson(text: string): MorningBriefEnvelope | null {
  return parseJsonResponse<MorningBriefEnvelope>(text);
}

/**
 * Standing instructions about what must never be raised again.
 *
 * A generator that rediscovers a vetoed idea every few weeks is worse than one that never had
 * it: each repeat says the refusal was not recorded. So the list goes into every morning prompt
 * verbatim, and it never expires.
 */
function buildVetoBlock(): string | null {
  try {
    const vetoes = queries.getVetoes();
    if (vetoes.length === 0) return null;
    const header = config.language === 'ru'
      ? '=== ЗАПРЕЩЁННЫЕ ТЕМЫ И ФОРМУЛИРОВКИ (никогда, ни в каком виде) ==='
      : '=== FORBIDDEN TOPICS AND PHRASINGS (never, in any form) ===';
    return `${header}\n${vetoes.map((v) => `- ${v.text}`).join('\n')}`;
  } catch (err) {
    logWarn('report.morning.veto_block_failed', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Counting material for the credit's "third time this month" line.
 *
 * The model is forbidden from inventing a number, so anything it may count has to arrive as
 * data. Wins are what the evening analysis already extracts; the credit tally is how many of
 * the previous credits he confirmed.
 */
function buildCreditContextBlock(yesterday: string): string {
  const parts: string[] = [];
  const ru = config.language === 'ru';

  try {
    const wins = queries.getWinsForDate(yesterday);
    if (wins.length > 0) {
      const label = ru ? 'Что вечерний разбор отметил как победы вчера' : "What yesterday's evening analysis recorded as wins";
      parts.push(`${label}:\n${wins.map((w) => `- ${w}`).join('\n')}`);
    }
  } catch { /* fail-soft: the credit can still be built from the transcript alone */ }

  // Both halves of the repetition guard: what the bot already credited (so it does not credit the
  // same walk three mornings running, and so a counter line has something real to count), and what
  // other people said (a different kind of evidence, and the only one about their reactions).
  try {
    const already = queries.getRecentMorningCredits(14);
    if (already.length > 0) {
      const label = ru
        ? 'УЖЕ ЗАСЧИТАНО РАНЬШЕ — не засчитывай то же самое ещё раз, если это не заметно более трудный случай'
        : 'ALREADY CREDITED BEFORE — do not credit the same thing again unless this instance was markedly harder';
      const disputed = ru ? ' (этот зачёт он оспорил)' : ' (this credit was disputed)';
      parts.push(`${label}:\n${
        already.map((c) => `- [${c.date}] «${c.quote}» — ${c.skill}${c.verdict === 'no' ? disputed : ''}`).join('\n')}`);
    }
  } catch { /* fail-soft */ }

  try {
    const start = shiftLocalDate(yesterday, -29);
    const recent = queries.getCreditsByDateRange(start, yesterday);
    if (recent.length > 0) {
      const label = ru ? 'Внешние отклики за 30 дней' : 'External responses over 30 days';
      parts.push(`${label}:\n${recent.map((c) => `- [${c.date}] ${c.text}`).join('\n')}`);
    }
  } catch { /* fail-soft */ }

  try {
    const stats = queries.getMorningCreditStats();
    parts.push(ru
      ? `Как он отвечал на прошлые зачёты: подтвердил ${stats.yes}, оспорил ${stats.no}, не вспомнил ${stats.unsure}, не ответил ${stats.unanswered}.`
      : `How past credits were answered: confirmed ${stats.yes}, disputed ${stats.no}, could not recall ${stats.unsure}, no answer ${stats.unanswered}.`);
  } catch { /* fail-soft */ }

  const veto = buildVetoBlock();
  if (veto) parts.push(veto);

  const header = ru ? '=== ДАННЫЕ ДЛЯ ЗАЧЁТА ===' : '=== DATA FOR THE CREDIT ===';
  return parts.length > 0 ? `${header}\n${parts.join('\n\n')}` : '';
}

function buildMorningBriefContext(today: string): { yesterday: string; context: string; hasYesterdayData: boolean } {
  const yesterday = shiftLocalDate(today, -1);
  const dayBefore = shiftLocalDate(today, -2);
  const yesterdaySummaries = buildDaySummaries(yesterday, yesterday);

  if (yesterdaySummaries.length === 0) {
    return { yesterday, context: '', hasYesterdayData: false };
  }

  const primaryContext = fitContext(yesterdaySummaries, MAX_CONTEXT_CHARS - 60_000);
  const ru = config.language === 'ru';
  const parts = [
    ru ? `Сегодняшнее утро: ${today}` : `This morning: ${today}`,
    ru ? `День, за который засчитываем: ${yesterday}` : `The day being credited: ${yesterday}`,
    buildCreditContextBlock(yesterday),
    ru ? `=== ВЧЕРА (${yesterday}) ===\n${primaryContext}` : `=== YESTERDAY (${yesterday}) ===\n${primaryContext}`,
  ].filter((p) => p.trim());

  const dayBeforeSummaries = buildDaySummaries(dayBefore, dayBefore);
  if (dayBeforeSummaries.length > 0) {
    const secondaryContext = formatSummariesCompact(dayBeforeSummaries).slice(0, 60_000);
    parts.push(ru
      ? `=== ПОЗАВЧЕРА (${dayBefore}, только чтобы понять контекст) ===\n${secondaryContext}`
      : `=== THE DAY BEFORE (${dayBefore}, context only) ===\n${secondaryContext}`);
  }

  return {
    yesterday,
    context: parts.join('\n\n---\n\n'),
    hasYesterdayData: true,
  };
}

async function runWithProvider(
  api: Api,
  chatId: number,
  context: string,
  systemPrompt: string,
  title: string,
  reportType: string,
  startStr: string,
  endStr: string,
  provider: LLMProvider,
  replyToMessageId?: number,
  extractDisplayText: (raw: string) => string = (raw) => raw.trim(),
): Promise<string> {
  const start = Date.now();
  logInfo('report.llm.start', {
    reportType,
    title,
    startDate: startStr,
    endDate: endStr,
    provider: provider.providerName,
    model: provider.modelName,
    contextChars: context.length,
    systemChars: systemPrompt.length,
    chatId,
    replyToMessageId,
  });
  const result = await provider.analyze(context, systemPrompt);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const displayText = extractDisplayText(result.text);

  queries.insertReport({
    type: reportType,
    period_start: startStr,
    period_end: endStr,
    report_text: displayText,
    llm_provider: provider.providerName,
    llm_model: provider.modelName,
  });

  const usage = result.usage
    ? ` | ${result.usage.inputTokens}in/${result.usage.outputTokens}out | $${result.usage.costUsd.toFixed(5)}`
    : '';
  let meta: string;
  if (config.compareMode) {
    meta = `<blockquote>${title}\n${provider.providerName} (${provider.modelName}) | ${elapsed}s${usage}</blockquote>`;
  } else {
    const costInfo = result.usage ? ` | $${result.usage.costUsd.toFixed(5)}` : '';
    meta = `<blockquote>${title}${costInfo}</blockquote>`;
  }
  // meta is already HTML — send raw text (not through markdownToHtml) for the meta part
  const body = markdownToHtml(displayText);
  await sendRawHtmlMessages(api, chatId, `${meta}\n\n${body}`, replyToMessageId);
  logInfo('report.llm.complete', {
    reportType,
    title,
    startDate: startStr,
    endDate: endStr,
    provider: provider.providerName,
    model: provider.modelName,
    elapsedSec: elapsed,
    outputChars: displayText.length,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    costUsd: result.usage?.costUsd?.toFixed(5),
  });

  return result.text;
}

function parseWeeklyEnvelope(text: string): WeeklyReportEnvelope | null {
  return parseJsonResponse<WeeklyReportEnvelope>(text);
}

/** Pull the human-readable report body out of the weekly JSON envelope (fail-soft). */
function extractWeeklyDisplayText(raw: string): string {
  const env = parseWeeklyEnvelope(raw);
  if (env && typeof env.report_text === 'string' && env.report_text.trim()) {
    return env.report_text.trim();
  }
  return stripJsonBlock(raw) || raw.trim();
}

/** This-week vs last-week distortion counters + active experiment context for the weekly report. */
/**
 * The week's behavioural facts: contract count, what survived the morning label review,
 * the open slot, and externally sourced credits. These are the numbers the report is
 * allowed to reason about — everything else in the week is narrative.
 */
function buildWeeklyMechanicsContext(startStr: string, endStr: string): string | null {
  const parts: string[] = [];
  const ru = config.language === 'ru';

  try {
    const stats = queries.getContractStats(startStr, endStr);
    const closed = stats.done + stats.missed;
    if (closed > 0 || stats.open > 0) {
      parts.push(ru
        ? `Контракты недели (один живой контакт до начала работы): зачёт ${stats.done} из ${closed + stats.open} дней; не закрыто ${stats.open}.`
        : `Contracts this week (one live contact before work): counted ${stats.done} of ${closed + stats.open} days; ${stats.open} still open.`);
    }
  } catch (err) {
    logWarn('report.weekly.contract_stats_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  // Per-day outcomes, not just the tally: the report is asked what the days that worked had in
  // common, and an aggregate cannot answer that.
  try {
    const days = queries.getContractsByRange(startStr, endStr);
    if (days.length) {
      const line = days.map((d) => `${d.date} ${d.status}${d.text ? ` (${d.text})` : ''}`).join('; ');
      parts.push(ru ? `Контракты по дням: ${line}` : `Contracts by day: ${line}`);
    }
  } catch (err) {
    logWarn('report.weekly.contract_days_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  try {
    const labels = queries.getLabelReviewStats();
    const total = labels.yes + labels.no + labels.partly;
    if (total > 0) {
      parts.push(ru
        ? `Ревизия ярлыков за всё время: разобрано ${total}; подтвердил утром ${labels.yes}, снял ${labels.no}, смягчил ${labels.partly}.`
        : `Label review, all time: ${total} reviewed; confirmed ${labels.yes}, dropped ${labels.no}, softened ${labels.partly}.`);
    }
  } catch (err) {
    logWarn('report.weekly.label_stats_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  try {
    const open = queries.getOpenSlot();
    if (open) {
      const details = [open.when_at, open.who, open.cost].filter(Boolean).join(', ');
      parts.push(ru
        ? `ОТКРЫТЫЙ СЛОТ (назначен на неделе от ${open.week_start}): ${open.text}${details ? ` — ${details}` : ''}.`
        : `OPEN SLOT (named in the week of ${open.week_start}): ${open.text}${details ? ` — ${details}` : ''}.`);
    } else {
      parts.push(ru ? 'ОТКРЫТОГО СЛОТА НЕТ.' : 'NO OPEN SLOT.');
    }
    const recent = queries.getRecentSlots(4).filter((sl) => sl.status !== 'open');
    if (recent.length) {
      const line = recent.map((sl) => `${sl.week_start}: ${sl.text} — ${sl.status}`).join('; ');
      parts.push(ru ? `Прошлые слоты: ${line}` : `Past slots: ${line}`);
    }
  } catch (err) {
    logWarn('report.weekly.slot_context_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  try {
    const credits = queries.getCreditsByDateRange(startStr, endStr);
    if (credits.length) {
      const label = ru ? 'Внешние зачёты недели (чужие реакции, дословно)' : 'External credits this week (other people\'s reactions, verbatim)';
      parts.push(`${label}:\n${credits.slice(0, 12).map((c) => `- ${c.date}: ${c.text}`).join('\n')}`);
    } else {
      parts.push(ru ? 'Внешних зачётов за неделю не зафиксировано.' : 'No external credits recorded this week.');
    }
  } catch (err) {
    logWarn('report.weekly.credits_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  try {
    const prevStart = shiftLocalDate(startStr, -7);
    const prevEnd = shiftLocalDate(startStr, -1);
    const counts = getDistortionCountsByRange([
      { start: prevStart, end: prevEnd },
      { start: startStr, end: endStr },
    ]);
    if (counts.length > 0) {
      const sorted = counts
        .sort((a, b) => (b.counts[0] + b.counts[1]) - (a.counts[0] + a.counts[1]))
        .slice(0, 7);
      const label = ru
        ? 'Счётчики паттернов (прошлая неделя → эта неделя)'
        : 'Pattern counters (last week → this week)';
      const line = sorted.map((c) => `${c.type} ${c.counts[0]}→${c.counts[1]}`).join(', ');
      parts.push(`${label}: ${line}`);
    }
  } catch (err) {
    logWarn('report.weekly.pattern_counters_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  // Previous reports, so the model can see what it has already recommended and refuse to
  // say it a fourth time. Truncated hard: this is a repetition guard, not extra context.
  try {
    const prev = queries.getReportsByDateRange('weekly', shiftLocalDate(startStr, -21), shiftLocalDate(startStr, -1));
    if (prev.length) {
      const label = ru
        ? 'УЖЕ СКАЗАНО В ПРОШЛЫХ ОТЧЁТАХ (не повторяй эти рекомендации)'
        : 'ALREADY SAID IN PREVIOUS REPORTS (do not repeat these recommendations)'
      parts.push(`${label}:\n${prev.slice(-2).map((r) => r.report_text.slice(0, 1200)).join('\n---\n')}`);
    }
  } catch (err) {
    logWarn('report.weekly.previous_reports_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  if (parts.length === 0) return null;
  const header = ru ? '=== МЕХАНИКИ И ПАТТЕРНЫ НЕДЕЛИ ===' : '=== WEEK MECHANICS AND PATTERNS ===';
  return `${header}\n${parts.join('\n\n')}`;
}

/**
 * Close the open slot if the week's report ruled on it. Slots are never auto-created here:
 * a slot only exists once he names a real date, person or payment in an entry — inventing
 * one on his behalf would recreate the assigned-task format this replaced.
 */
function applyWeeklySlot(env: WeeklyReportEnvelope): void {
  try {
    const verdict = env.slot_verdict;
    if (verdict?.status !== 'kept' && verdict?.status !== 'missed') return;
    const open = queries.getOpenSlot();
    if (!open) return;
    queries.closeSlot(open.id, {
      status: verdict.status,
      result_note: typeof verdict.note === 'string' ? verdict.note : undefined,
    });
    logInfo('slot.weekly.closed', { slotId: open.id, status: verdict.status });
  } catch (err) {
    logWarn('slot.weekly.apply_failed', { reason: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Retire any experiment left active by the previous format. Runs once: after the first
 * weekly report under the new mechanics there is nothing left to close.
 */
function retireLegacyExperiment(today: string): void {
  try {
    const active = queries.getActiveExperiment();
    if (!active) return;
    queries.closeExperiment(active.id, {
      status: 'skipped',
      result_note: config.language === 'ru'
        ? 'Формат «эксперимент недели» заменён контрактом дня и слотом недели'
        : 'The weekly-experiment format was replaced by the daily contract and the weekly slot',
      end_date: today,
    });
    logInfo('experiment.retired', { experimentId: active.id });
  } catch (err) {
    logWarn('experiment.retire_failed', { reason: err instanceof Error ? err.message : String(err) });
  }
}

async function runWeeklyReport(
  api: Api,
  chatId: number,
  startStr: string,
  endStr: string,
  reportType: 'weekly' | 'test_weekly',
): Promise<void> {
  const summaries = buildDaySummaries(startStr, endStr);
  logInfo('report.weekly.start', {
    reportType,
    startDate: startStr,
    endDate: endStr,
    summaryCount: summaries.length,
    chatId,
  });
  if (summaries.length === 0) {
    logWarn('report.weekly.empty', { reportType, startDate: startStr, endDate: endStr, chatId });
    await sendSplitMessages(api, chatId, `No entries found for ${startStr} — ${endStr}\n\n#bot`);
    return;
  }

  const baseContext = fitContext(summaries, MAX_CONTEXT_CHARS);
  const mechanicsContext = buildWeeklyMechanicsContext(startStr, endStr);
  const context = mechanicsContext ? `${mechanicsContext}\n\n---\n\n${baseContext}` : baseContext;
  const systemPrompt = buildSystemPromptWithMemory(getWeeklySystemPrompt(config.language));

  const strings = t();
  const prefix = reportType === 'test_weekly' ? '🧪 TEST ' : '';
  const title = prefix + strings.weeklyReportTitle
    .replace('{start}', startStr)
    .replace('{end}', endStr);

  // Post short header to channel, get comment target for full content
  const target = await postChannelHeader(api, chatId, config.telegram.discussionGroupId, title);

  // Attach a 30-day metrics chart under the header (never blocks the text report)
  await sendMetricsChart(api, target, endStr);

  const providers = config.compareMode ? createAllLLMProviders() : [createLLMProvider()];

  // The CONFIGURED primary provider's envelope drives the experiment lifecycle.
  // If the primary fails or returns an unparsable envelope, fall back to any other
  // successful provider so a single outage doesn't silently stall the weekly experiment.
  let primaryEnvelope: WeeklyReportEnvelope | null = null;
  let fallbackEnvelope: WeeklyReportEnvelope | null = null;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      const raw = await runWithProvider(
        api, target.chatId, context, systemPrompt, title, reportType, startStr, endStr, provider, target.replyToMessageId,
        extractWeeklyDisplayText,
      );
      const envelope = parseWeeklyEnvelope(raw);
      if (provider.providerName === config.llm.provider) {
        primaryEnvelope = envelope;
      } else if (!fallbackEnvelope) {
        fallbackEnvelope = envelope;
      }
    } catch (err) {
      logError('report.weekly.provider_failed', err, {
        reportType,
        startDate: startStr,
        endDate: endStr,
        provider: provider.providerName,
        model: provider.modelName,
      });
      const label = `${provider.providerName} (${provider.modelName})`;
      const errMsg = err instanceof Error ? err.message : String(err);
      await sendRawHtmlMessages(api, target.chatId, `<blockquote>${title}\n${label}</blockquote>\n\nError: ${errMsg}`, target.replyToMessageId);
    }
  }

  // Only the real weekly report (not test runs) mutates the experiment lifecycle.
  const effectiveEnvelope = primaryEnvelope ?? fallbackEnvelope;
  if (!primaryEnvelope && fallbackEnvelope) {
    logWarn('report.weekly.slot_fallback_envelope', {
      reportType,
      configuredPrimary: config.llm.provider,
    });
  }
  if (reportType === 'weekly') {
    retireLegacyExperiment(todayLocal());
    if (effectiveEnvelope) applyWeeklySlot(effectiveEnvelope);
  }
}

/**
 * The counted material a monthly report is allowed to state as fact.
 *
 * Only credits he confirmed with a tap go in. An unconfirmed credit is the bot's guess about
 * his behaviour, and a month that reads its own guesses back to him as achievements is exactly
 * the curated cheer the old "Позитивные моменты" section produced.
 */
function buildMonthlyMechanicsContext(startStr: string, endStr: string): string | null {
  const parts: string[] = [];
  const ru = config.language === 'ru';

  try {
    const confirmed = queries.getConfirmedMorningCredits(startStr, endStr);
    if (confirmed.length) {
      const label = ru
        ? `Зачёты, которые он сам подтвердил кнопкой (дословно, ${confirmed.length} шт.)`
        : `Credits confirmed with a tap (verbatim, ${confirmed.length})`;
      parts.push(`${label}:\n${confirmed.map((c) => `- ${c.date}: «${c.quote}» — ${c.skill}`).join('\n')}`);
    } else {
      parts.push(ru ? 'Подтверждённых зачётов за месяц нет.' : 'No confirmed credits this month.');
    }
    const stats = queries.getMorningCreditStatsByRange(startStr, endStr);
    parts.push(ru
      ? `Зачёты за месяц: подтвердил ${stats.yes}, оспорил ${stats.no}, не вспомнил ${stats.unsure}, не ответил ${stats.unanswered}.`
      : `Credits this month: confirmed ${stats.yes}, disputed ${stats.no}, could not recall ${stats.unsure}, no answer ${stats.unanswered}.`);
  } catch (err) {
    logWarn('report.monthly.credit_context_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  try {
    const stats = queries.getContractStats(startStr, endStr);
    const total = stats.done + stats.missed + stats.open;
    if (total > 0) parts.push(ru
      ? `Контракты за месяц: зачёт ${stats.done} из ${total} дней; не закрыто ${stats.open}.`
      : `Contracts this month: counted ${stats.done} of ${total} days; ${stats.open} still open.`);
  } catch (err) {
    logWarn('report.monthly.contract_stats_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  try {
    const labels = queries.getLabelReviewStats();
    const total = labels.yes + labels.no + labels.partly;
    if (total > 0) {
      parts.push(ru
        ? `Ревизия ярлыков за всё время: разобрано ${total}; подтвердил утром ${labels.yes}, снял ${labels.no}, смягчил ${labels.partly}.`
        : `Label review, all time: ${total} reviewed; confirmed ${labels.yes}, dropped ${labels.no}, softened ${labels.partly}.`);
    }
  } catch (err) {
    logWarn('report.monthly.label_stats_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  try {
    const credits = queries.getCreditsByDateRange(startStr, endStr);
    const label = ru ? 'Внешние зачёты за месяц (чужие реакции, дословно)' : "External credits this month (other people's reactions, verbatim)";
    parts.push(credits.length
      ? `${label}:\n${credits.slice(0, 20).map((c) => `- ${c.date}: ${c.text}`).join('\n')}`
      : (ru ? 'Внешних зачётов за месяц не зафиксировано.' : 'No external credits recorded this month.'));
  } catch (err) {
    logWarn('report.monthly.credits_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  const header = ru ? '=== МЕХАНИКИ МЕСЯЦА ===' : '=== MONTH MECHANICS ===';
  return parts.length ? `${header}\n${parts.join('\n\n')}` : null;
}

async function runMonthlyReport(
  api: Api,
  chatId: number,
  startStr: string,
  endStr: string,
  reportType: 'monthly' | 'test_monthly',
): Promise<void> {
  const weeklyReports = queries.getReportsByDateRange('weekly', startStr, endStr);
  const testWeeklyReports = queries.getReportsByDateRange('test_weekly', startStr, endStr);
  const allWeeklyReports = [...weeklyReports, ...testWeeklyReports].sort(
    (a, b) => a.period_start.localeCompare(b.period_start),
  );

  const summaries = buildDaySummaries(startStr, endStr);
  logInfo('report.monthly.start', {
    reportType,
    startDate: startStr,
    endDate: endStr,
    summaryCount: summaries.length,
    weeklyReportCount: allWeeklyReports.length,
    chatId,
  });

  if (summaries.length === 0 && allWeeklyReports.length === 0) {
    logWarn('report.monthly.empty', {
      reportType,
      startDate: startStr,
      endDate: endStr,
      chatId,
    });
    await sendSplitMessages(api, chatId, `No entries found for ${startStr} — ${endStr}\n\n#bot`);
    return;
  }

  const parts: string[] = [];

  // Mechanics go first: they are the only counted facts in the context, and the trimming path
  // below drops daily entries before weekly reports — so anything appended after them can be cut.
  const monthlyMechanics = buildMonthlyMechanicsContext(startStr, endStr);
  if (monthlyMechanics) parts.push(monthlyMechanics);

  if (allWeeklyReports.length > 0) {
    parts.push('=== Weekly Reports ===');
    for (const r of allWeeklyReports) {
      parts.push(`[${r.period_start} — ${r.period_end}]\n${r.report_text}`);
    }
  }

  if (summaries.length > 0) {
    parts.push('=== Daily Entries ===');
    parts.push(formatSummariesCompact(summaries));
  }

  let fullContext = parts.join('\n\n---\n\n');

  if (fullContext.length > MAX_CONTEXT_CHARS && allWeeklyReports.length > 0) {
    const trimmedParts: string[] = [];
    if (monthlyMechanics) trimmedParts.push(monthlyMechanics);
    trimmedParts.push('=== Weekly Reports ===');
    for (const r of allWeeklyReports) {
      trimmedParts.push(`[${r.period_start} — ${r.period_end}]\n${r.report_text}`);
    }
    const metricsOnly = summaries
      .filter((s) => s.metrics)
      .map((s) => `[${s.date}] ${s.metrics}`)
      .join('\n');
    if (metricsOnly) {
      trimmedParts.push('=== Daily Metrics ===');
      trimmedParts.push(metricsOnly);
    }
    fullContext = trimmedParts.join('\n\n---\n\n');
  }

  const systemPrompt = buildSystemPromptWithMemory(getMonthlySystemPrompt(config.language));

  const strings = t();
  const prefix = reportType === 'test_monthly' ? '🧪 TEST ' : '';
  const title = prefix + strings.monthlyReportTitle
    .replace('{start}', startStr)
    .replace('{end}', endStr);

  // Post short header to channel, get comment target for full content
  const target = await postChannelHeader(api, chatId, config.telegram.discussionGroupId, title);

  // Attach a 30-day metrics chart under the header (never blocks the text report)
  await sendMetricsChart(api, target, endStr);

  const providers = config.compareMode ? createAllLLMProviders() : [createLLMProvider()];

  for (const provider of providers) {
    try {
      await runWithProvider(api, target.chatId, fullContext, systemPrompt, title, reportType, startStr, endStr, provider, target.replyToMessageId);
    } catch (err) {
      logError('report.monthly.provider_failed', err, {
        reportType,
        startDate: startStr,
        endDate: endStr,
        provider: provider.providerName,
        model: provider.modelName,
      });
      const label = `${provider.providerName} (${provider.modelName})`;
      const errMsg = err instanceof Error ? err.message : String(err);
      await sendRawHtmlMessages(api, target.chatId, `<blockquote>${title}\n${label}</blockquote>\n\nError: ${errMsg}`, target.replyToMessageId);
    }
  }
}

/**
 * The single question this morning carries, if any.
 *
 * Telegram draws the keyboard under the whole message rather than beside the line it belongs to,
 * so a message may hold exactly one question, placed last. That turns question selection into a
 * priority chain instead of a checklist: the credit wins when there is one, because it is the
 * thing he asked for; the label review takes over on the days nothing was worth crediting, which
 * are exactly the days he said something absolute worth reading back.
 */
export interface MorningAsk {
  text: string;
  keyboard: InlineKeyboard;
  kind: 'credit' | 'label';
}

function buildLabelAsk(yesterday: string): MorningAsk | null {
  try {
    const pending = queries.getLabelForReview(yesterday);
    if (!pending) return null;
    const at = pending.said_at ? `, ${pending.said_at}` : '';
    return {
      kind: 'label',
      keyboard: labelKeyboard(pending.id),
      text: `<b>${t().labelAskPrefix.replace('{at}', at)}</b>\n<blockquote>${escapeHtml(pending.quote)}</blockquote>\n${t().labelAskQuestion}`,
    };
  } catch (err) {
    logWarn('report.morning.label_ask_failed', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Close out yesterday before opening today, so the counters describe what actually happened. */
function runMorningHousekeeping(today: string): void {
  try {
    const missed = queries.markStaleContractsMissed(today);
    // Three days is the honesty horizon for a label: past that he is reconstructing, not remembering.
    const expired = queries.expireLabels(shiftLocalDate(today, -3));
    queries.openContract(today);
    if (missed || expired) logInfo('report.morning.housekeeping', { today, contractsMissed: missed, labelsExpired: expired });
  } catch (err) {
    logWarn('report.morning.housekeeping_failed', { today, reason: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Does the credit's quote actually appear in what was said yesterday?
 *
 * The whole mechanic rests on the quote being verbatim — a credit built on a paraphrase is the
 * bot telling the user what they said, which is the opposite of the point. The prompt forbids
 * paraphrase, and a model still reordered a sentence on the first mixed-language run, so the
 * rule is enforced here rather than trusted there.
 *
 * Matching is loose on everything that is not the words: case, punctuation, and whitespace vary
 * between the transcript and what a model echoes back, and rejecting on those would throw away
 * good credits.
 */
function quoteAppearsIn(quote: string, haystack: string): boolean {
  const normalize = (text: string) =>
    text.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const needle = normalize(quote);
  if (needle.length < 8) return false;
  return normalize(haystack).includes(needle);
}

export interface ComposedMorning {
  body: string;
  ask: MorningAsk | null;
  credit: { quote: string; skill: string; counter: string } | null;
}

/**
 * Turn the model's envelope into the message that gets sent, or into nothing.
 *
 * Pure, and separate from the sending, because every rule that matters lives here: a credit is
 * only a credit when it has both a verbatim quote and a named skill (a paraphrase is the
 * failure mode this rewrite exists to prevent), a bare note asks nothing at all, and an empty
 * envelope falls through to the label review before it falls through to silence.
 *
 * Returns null when the morning should not be sent. That is a supported outcome: the previous
 * version had no way to say nothing, so it said something every day for 142 days.
 */
export function composeMorning(
  parsed: MorningBriefEnvelope,
  today: string,
  labelAsk: MorningAsk | null,
): ComposedMorning | null {
  const quote = typeof parsed.credit?.quote === 'string' ? parsed.credit.quote.trim() : '';
  const skill = typeof parsed.credit?.skill === 'string' ? parsed.credit.skill.trim() : '';
  const counter = typeof parsed.credit?.counter === 'string' ? parsed.credit.counter.trim() : '';
  const note = typeof parsed.note === 'string' ? parsed.note.trim() : '';

  if (parsed.skip !== true && quote && skill) {
    const counterLine = counter ? `\n<i>${escapeHtml(counter)}</i>` : '';
    return {
      body: `<b>${t().morningCreditHeader}</b>\n<blockquote>${escapeHtml(quote)}</blockquote>\n${escapeHtml(skill)}${counterLine}`,
      ask: { kind: 'credit', keyboard: creditKeyboard(today), text: t().morningCreditAsk },
      credit: { quote, skill, counter },
    };
  }

  // A large external event with nothing to credit: name it, ask nothing.
  if (note) return { body: escapeHtml(note), ask: null, credit: null };

  if (labelAsk) return { body: '', ask: labelAsk, credit: null };

  return null;
}

/**
 * Morning message.
 *
 * This used to be a task for today. Across 47 mornings that carried a concrete request, not one
 * was carried out in the form it asked for — 32 of them asked him to write something down, and
 * he does not type. So it now runs backwards: it names one thing he already did, quotes him
 * doing it, and asks him to confirm the record rather than to perform anything.
 *
 * Silence is a supported outcome and not a failure path. The previous version sent 142 mornings
 * in a row and got zero replies; an unbroken streak of ignored messages does not build a habit,
 * it teaches the channel is noise.
 */
async function runMorningBrief(
  api: Api,
  chatId: number,
  today: string,
  reportType: 'morning_brief' | 'test_morning_brief',
): Promise<void> {
  const isTest = reportType === 'test_morning_brief';

  // A test run must not open a real contract or close yesterday's.
  if (!isTest) runMorningHousekeeping(today);

  const { yesterday, context, hasYesterdayData } = buildMorningBriefContext(today);
  logInfo('report.morning.start', { reportType, today, yesterday, hasYesterdayData, contextChars: context.length, chatId });

  // No entry yesterday means nothing to credit and nothing to read back. The old code sent a
  // nudge to write tonight; that is a task, and it is the task he ignored most reliably.
  if (!hasYesterdayData) {
    const ask = buildLabelAsk(yesterday);
    if (!ask) {
      logInfo('report.morning.silent', { reportType, today, yesterday, reason: 'no entry yesterday' });
      return;
    }
    await sendMorning(api, chatId, today, yesterday, reportType, '', ask, null);
    return;
  }

  const systemPrompt = buildSystemPromptWithMemory(getMorningSystemPrompt(config.language));
  const llm = createLLMProvider();
  const start = Date.now();
  const result = await llm.analyze(context, systemPrompt);
  const parsed = parseMorningBriefJson(result.text);

  if (!parsed) {
    // Without a parsed envelope there is no quote to stand behind, and a morning message that
    // invents its own evidence is the exact failure this rewrite exists to remove.
    logWarn('report.morning.parse_failed', {
      reportType, today, yesterday, provider: llm.providerName, model: llm.modelName, outputChars: result.text.length,
    });
    return;
  }

  // Drop a credit whose quote is not actually in yesterday's text; the label review takes over.
  if (parsed.credit?.quote) {
    const saidYesterday = queries.getEntriesByDateRange(yesterday, yesterday)
      .map((e) => e.transcript || e.raw_text || '')
      .join('\n');
    if (!quoteAppearsIn(parsed.credit.quote, saidYesterday)) {
      logWarn('report.morning.quote_not_verbatim', {
        reportType, today, yesterday, provider: llm.providerName, model: llm.modelName,
        quote: parsed.credit.quote.slice(0, 120),
      });
      parsed.credit = null;
    }
  }

  const composed = composeMorning(parsed, today, buildLabelAsk(yesterday));
  if (!composed) {
    logInfo('report.morning.silent', {
      reportType, today, yesterday, provider: llm.providerName, model: llm.modelName,
      skip: parsed.skip === true, elapsedMs: Date.now() - start,
    });
    return;
  }
  const { body, ask, credit } = composed;

  await sendMorning(api, chatId, today, yesterday, reportType, body, ask, {
    provider: llm.providerName,
    model: llm.modelName,
    costUsd: result.usage?.costUsd,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    elapsedMs: Date.now() - start,
    credit,
  });
}

interface MorningSendMeta {
  provider: string;
  model: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  elapsedMs: number;
  credit: { quote: string; skill: string; counter: string } | null;
}

/**
 * Post the morning: a short line to the channel, the message itself as a comment.
 *
 * The split is not cosmetic. An inline keyboard on a channel post replaces the "Comments"
 * button, which would cut the thread off from the one message that most invites a reply — so
 * the buttons have to live in the discussion group, and the channel gets a header only.
 */
async function sendMorning(
  api: Api,
  chatId: number,
  today: string,
  yesterday: string,
  reportType: 'morning_brief' | 'test_morning_brief',
  body: string,
  ask: MorningAsk | null,
  meta: MorningSendMeta | null,
): Promise<void> {
  const isTest = reportType === 'test_morning_brief';
  const prefix = isTest ? '🧪 TEST ' : '';
  const strings = t();
  const header = `${prefix}${ask?.kind === 'label' ? strings.morningHeaderLabel : strings.morningHeaderCredit} · ${today}`;

  // The question goes last and alone, so the buttons sit directly under the sentence they answer.
  const html = [body, ask?.text].filter((p) => p && p.trim()).join('\n\n');

  const target = chatId === config.telegram.channelId
    ? await postChannelHeader(api, chatId, config.telegram.discussionGroupId, `<blockquote>${header}</blockquote>`)
    : { chatId, replyToMessageId: undefined };

  const messageIds = await sendRawHtmlMessages(api, target.chatId, `${html}\n\n#bot`, target.replyToMessageId, {
    keyboard: ask?.keyboard,
  });

  queries.insertReport({
    type: reportType,
    period_start: yesterday,
    period_end: today,
    report_text: html,
    llm_provider: meta?.provider,
    llm_model: meta?.model,
  });

  // Only a real credit gets a row: the button writes its verdict back by date, and a row without
  // a credit would make the confirmed/disputed counter count label reviews as well.
  if (!isTest && meta?.credit) {
    try {
      queries.insertMorningCredit({
        date: today,
        source_date: yesterday,
        quote: meta.credit.quote,
        skill: meta.credit.skill,
        counter: meta.credit.counter || undefined,
        message_id: messageIds[messageIds.length - 1],
      });
    } catch (err) {
      logWarn('report.morning.credit_persist_failed', { today, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  logInfo('report.morning.complete', {
    reportType,
    today,
    yesterday,
    ask: ask?.kind ?? 'none',
    bodyChars: html.length,
    provider: meta?.provider,
    model: meta?.model,
    elapsedMs: meta?.elapsedMs,
    inputTokens: meta?.inputTokens,
    outputTokens: meta?.outputTokens,
    costUsd: meta?.costUsd?.toFixed(5),
  });
}

// Scheduled: previous full week (Mon-Sun)
export async function generateWeeklyReport(api: Api, chatId: number): Promise<void> {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  await runWeeklyReport(api, chatId, formatDateLocal(start), formatDateLocal(end), 'weekly');

  // Auto-update memory after scheduled weekly report
  try {
    await updateMemoryFromReport(api, chatId);
  } catch (err) {
    logError('memory.auto_update_failed', err, { chatId });
  }
}

// Scheduled: previous full month
export async function generateMonthlyReport(api: Api, chatId: number): Promise<void> {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  await runMonthlyReport(api, chatId, formatDateLocal(start), formatDateLocal(end), 'monthly');
}

export async function generateMorningBrief(api: Api, chatId: number): Promise<void> {
  const today = todayLocal();
  const yesterday = shiftLocalDate(today, -1);

  if (queries.hasReportForPeriod('morning_brief', yesterday, today)) {
    logInfo('report.morning.skip_duplicate', { today, yesterday, chatId });
    return;
  }

  await runMorningBrief(api, chatId, today, 'morning_brief');
}

// Command: current week so far (Monday → today)
export async function generateTestWeeklyReport(api: Api, chatId: number): Promise<void> {
  const now = new Date();
  const monday = getMonday(now);
  await runWeeklyReport(api, chatId, formatDateLocal(monday), formatDateLocal(now), 'test_weekly');
}

// Command: current month so far (1st → today)
export async function generateTestMonthlyReport(api: Api, chatId: number): Promise<void> {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  await runMonthlyReport(api, chatId, formatDateLocal(firstDay), formatDateLocal(now), 'test_monthly');
}

export async function generateTestMorningBrief(api: Api, chatId: number): Promise<void> {
  await runMorningBrief(api, chatId, todayLocal(), 'test_morning_brief');
}

// Update memory using the latest weekly report
async function updateMemoryFromReport(api: Api, chatId: number): Promise<void> {
  // Get the most recent weekly report
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  const reports = queries.getReportsByDateRange('weekly', formatDateLocal(start), formatDateLocal(end));
  if (reports.length === 0) {
    logInfo('memory.auto_update.skip_no_weekly_report', {
      chatId,
      startDate: formatDateLocal(start),
      endDate: formatDateLocal(end),
    });
    return;
  }

  const latestReport = reports[reports.length - 1];
  const currentMemory = queries.getMemory();

  const systemPrompt = getMemoryUpdatePrompt(config.language);
  const userPrompt = config.language === 'ru'
    ? `Текущая память:\n${currentMemory || '(пусто)'}\n\n--- Недельный отчёт (${latestReport.period_start} — ${latestReport.period_end}) ---\n${latestReport.report_text}`
    : `Current memory:\n${currentMemory || '(empty)'}\n\n--- Weekly report (${latestReport.period_start} — ${latestReport.period_end}) ---\n${latestReport.report_text}`;

  const llm = createLLMProvider();
  const startTs = Date.now();
  const result = await llm.analyze(userPrompt, systemPrompt);
  const newMemory = result.text.trim().slice(0, MEMORY_MAX_LENGTH);

  if (newMemory) {
    queries.setMemory(newMemory);
    const costInfo = result.usage ? ` | $${result.usage.costUsd.toFixed(5)}` : '';
    const headerText = config.language === 'ru'
      ? `🧠 Память обновлена${costInfo}`
      : `🧠 Memory updated${costInfo}`;
    const target = await postChannelHeader(api, chatId, config.telegram.discussionGroupId, headerText);
    await sendRawHtmlMessages(api, target.chatId, newMemory, target.replyToMessageId);
    logInfo('memory.auto_update.complete', {
      chatId,
      elapsedMs: Date.now() - startTs,
      memoryChars: newMemory.length,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      costUsd: result.usage?.costUsd?.toFixed(5),
    });
  }
}

// Generate/update memory on demand (from /generatememory command)
export async function generateMemory(api: Api, chatId: number): Promise<void> {
  // Use last 4 weeks of weekly reports + recent daily summaries as context
  const now = new Date();
  const fourWeeksAgo = new Date(now);
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const startStr = formatDateLocal(fourWeeksAgo);
  const endStr = formatDateLocal(now);

  const weeklyReports = [
    ...queries.getReportsByDateRange('weekly', startStr, endStr),
    ...queries.getReportsByDateRange('test_weekly', startStr, endStr),
  ].sort((a, b) => a.period_start.localeCompare(b.period_start));

  const summaries = buildDaySummaries(startStr, endStr);

  if (weeklyReports.length === 0 && summaries.length === 0) {
    logWarn('memory.generate.empty', { chatId, startDate: startStr, endDate: endStr });
    const msg = config.language === 'ru'
      ? 'Нет данных для генерации памяти.\n\n#bot'
      : 'No data to generate memory.\n\n#bot';
    await api.sendMessage(chatId, msg);
    return;
  }

  const parts: string[] = [];
  if (weeklyReports.length > 0) {
    parts.push('=== Weekly Reports ===');
    for (const r of weeklyReports) {
      parts.push(`[${r.period_start} — ${r.period_end}]\n${r.report_text}`);
    }
  }
  if (summaries.length > 0) {
    parts.push('=== Recent Entries ===');
    parts.push(formatSummariesCompact(summaries));
  }

  const context = parts.join('\n\n---\n\n').slice(0, MAX_CONTEXT_CHARS);
  const currentMemory = queries.getMemory();

  const systemPrompt = getMemoryUpdatePrompt(config.language);
  const userPrompt = config.language === 'ru'
    ? `Текущая память:\n${currentMemory || '(пусто)'}\n\n${context}`
    : `Current memory:\n${currentMemory || '(empty)'}\n\n${context}`;

  const llm = createLLMProvider();
  const startTs = Date.now();
  const result = await llm.analyze(userPrompt, systemPrompt);
  const newMemory = result.text.trim().slice(0, MEMORY_MAX_LENGTH);

  if (newMemory) {
    queries.setMemory(newMemory);
    const costInfo = result.usage ? ` | $${result.usage.costUsd.toFixed(5)}` : '';
    const headerText = config.language === 'ru'
      ? `🧠 Память сгенерирована${costInfo}`
      : `🧠 Memory generated${costInfo}`;
    const target = await postChannelHeader(api, chatId, config.telegram.discussionGroupId, headerText);
    await sendRawHtmlMessages(api, target.chatId, newMemory, target.replyToMessageId);
    logInfo('memory.generate.complete', {
      chatId,
      elapsedMs: Date.now() - startTs,
      memoryChars: newMemory.length,
      contextChars: context.length,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      costUsd: result.usage?.costUsd?.toFixed(5),
    });
  }
}
