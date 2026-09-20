import type { Api } from 'grammy';
import { createLLMProvider, createAllLLMProviders, type LLMProvider } from '../providers/llm/index.js';
import { getWeeklySystemPrompt } from '../prompts/weekly.js';
import { getMonthlySystemPrompt } from '../prompts/monthly.js';
import { config } from '../config.js';
import { t } from '../i18n/index.js';
import { queries } from '../db/index.js';
import { sendSplitMessages, sendRawHtmlMessages, markdownToHtml, postChannelHeader } from '../utils/telegram.js';
import { formatDateLocal, shiftLocalDate, todayLocal } from '../utils/date.js';
import { formatCompactNumber } from '../utils/format.js';
import type { MetricsRow } from '../db/queries.js';
import { parseJsonResponse, stripJsonBlock } from '../utils/json.js';
import { getMemoryUpdatePrompt, MEMORY_MAX_LENGTH } from '../prompts/memory.js';
import { sendMetricsChart } from './charts.js';
import { getDistortionCountsByRange } from './patterns.js';
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

interface ReportEnvelope {
  report_text?: string;
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

/**
 * Standing instructions about what must never be raised again.
 *
 * A generator that rediscovers a vetoed idea every few weeks is worse than one that never had
 * it: each repeat says the refusal was not recorded. So the list goes into every weekly and
 * monthly prompt verbatim, and it never expires.
 */
function buildVetoBlock(): string | null {
  try {
    const vetoes = queries.getVetoes();
    if (vetoes.length === 0) return null;
    const header = config.language === 'ru'
      ? '=== НИКОГДА НЕ ПОДНИМАТЬ (ни в каком виде) ==='
      : '=== NEVER RAISE (in any form) ===';
    return `${header}\n${vetoes.map((v) => `- ${v.text}`).join('\n')}`;
  } catch (err) {
    logWarn('report.veto_block_failed', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
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

const LOOSE_FENCE = /```[a-z]*\s*([\s\S]*?)\s*```/i;

/**
 * Pull the letter out of the JSON envelope (fail-soft). Weekly and monthly share it. A model
 * that fences the JSON without the "json" tag still gets its letter through rather than its
 * raw envelope sent to the channel.
 */
function extractReportDisplayText(raw: string): string {
  const env = parseJsonResponse<ReportEnvelope>(raw);
  if (env && typeof env.report_text === 'string' && env.report_text.trim()) {
    return env.report_text.trim();
  }
  const loose = raw.match(LOOSE_FENCE);
  if (loose) {
    try {
      const alt = JSON.parse(loose[1]) as ReportEnvelope;
      if (typeof alt.report_text === 'string' && alt.report_text.trim()) return alt.report_text.trim();
    } catch { /* not JSON — fall through to the raw text */ }
  }
  return stripJsonBlock(raw) || raw.trim();
}

const normalizeForMatch = (text: string) =>
  text.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Quotation marks only around what he actually said.
 *
 * The letter quotes him back to himself, and that only works while the quotes are his words:
 * the model reorders a sentence or splices two with an ellipsis about one time in ten, and the
 * evening analyses paraphrase other people's responses in the third person. A quote that is
 * not in the period's transcripts keeps its text and loses its quotation marks — the fact
 * stays, the claim that these were his words goes.
 */
export function enforceVerbatimQuotes(text: string, saidInPeriod: string): string {
  const hay = normalizeForMatch(saidInPeriod);
  let dropped = 0;
  // Each opener pairs with its own closer. Straight quotes are matched as whole spans of any
  // length so a closing " can never be re-read as the opener of a bogus merged quote; spans
  // under twelve characters are left alone either way.
  const out = text.replace(/«([^«»\n]{12,}?)»|“([^“”\n]{12,}?)”|"([^"\n]*?)"/g, (whole, a?: string, b?: string, c?: string) => {
    const inner = a ?? b ?? c ?? '';
    if (inner.length < 12 || hay.includes(normalizeForMatch(inner))) return whole;
    dropped++;
    return inner;
  });
  if (dropped) logInfo('report.quotes_unquoted', { dropped });
  return out;
}

/** Everything he said in the period — entries and his thread replies — for the verbatim-quote guard. */
function transcriptsForRange(startStr: string, endStr: string): string {
  const entries = queries.getEntriesByDateRange(startStr, endStr);
  const threads = queries.getAllThreadMessages(entries.map((e) => e.telegram_message_id));
  const said: string[] = [];
  for (const e of entries) {
    said.push(e.transcript || e.raw_text || '');
    for (const m of threads.get(e.telegram_message_id) ?? []) {
      if (m.role === 'user') said.push(m.content);
    }
  }
  return said.join('\n');
}

type MetricKey = 'mood' | 'anxiety' | 'stress' | 'productivity' | 'routine';

/** Average of daily averages: a day with two entries has two metric rows and must not count twice. */
function averageByDay(rows: MetricsRow[], key: MetricKey): number | null {
  const byDay = new Map<string, number[]>();
  for (const r of rows) {
    const v = r[key];
    if (typeof v !== 'number') continue;
    byDay.set(r.date, [...(byDay.get(r.date) ?? []), v]);
  }
  if (byDay.size === 0) return null;
  const days = [...byDay.values()].map((vs) => vs.reduce((a, b) => a + b, 0) / vs.length);
  return days.reduce((a, b) => a + b, 0) / days.length;
}

/** "настроение 5,4 (прошлая неделя 5,2); тревога …" — averaged per day, then per week. */
function formatWeekAverages(startStr: string, endStr: string, ru: boolean, withPrev = true): string | null {
  const names = t().metricNames;
  const keys: MetricKey[] = ['mood', 'anxiety', 'stress', 'productivity', 'routine'];
  const thisWeek = queries.getMetricsByDateRange(startStr, endStr);
  const lastWeek = withPrev ? queries.getMetricsByDateRange(shiftLocalDate(startStr, -7), shiftLocalDate(startStr, -1)) : [];
  if (thisWeek.length === 0) return null;
  const cells = keys.map((k) => {
    const cur = averageByDay(thisWeek, k);
    const prev = averageByDay(lastWeek, k);
    if (cur === null) return null;
    const prevText = prev === null ? '' : ru ? ` (прошлая неделя ${formatCompactNumber(prev)})` : ` (last week ${formatCompactNumber(prev)})`;
    return `${names[k].toLowerCase()} ${formatCompactNumber(cur)}${prevText}`;
  }).filter((c): c is string => c !== null);
  if (cells.length === 0) return null;
  const label = ru
    ? 'Средние метрики за неделю по его вечерним оценкам (для одного предложения с подписями; числа «неделей раньше» — только отсюда)'
    : 'Average metrics for the week from their evening ratings (for the one labelled sentence; "week before" figures come only from here)';
  return `${label}: ${cells.join('; ')}.`;
}

/** Lines of the retired report format that must not be read as material: tallies and their headings. */
function stripLegacyCounters(report: string): string {
  return report
    .split('\n')
    .filter((line) => !/^##\s*(Диф недели|Метрики|Контракты|Слот|Ярлыки|Week diff|Metrics|Contracts|Slot|Labels)/i.test(line))
    .filter((line) => !/\d\s*→\s*\d|\b\d+ (из|of) \d+\b|^\d+([,.]\d+)?[–-]\d/.test(line))
    .join('\n');
}

/**
 * What the weekly letter may state beyond the entries themselves: other people's responses
 * (verbatim, the only proof he did not produce himself), the distortion counters for two weeks
 * (background for the observation, never to be printed as "X → Y"), the two previous letters
 * (a repetition guard), and the standing vetoes.
 *
 * The contract tally, the label-review shares and the open slot used to be here too. They came
 * out of the report as bookkeeping — "5 из 7", "подтверждено 0; снято 0", a question about the
 * slot asked three weeks running with no answer — and were retired with the morning message.
 */
function buildWeeklyMechanicsContext(startStr: string, endStr: string): string | null {
  const parts: string[] = [];
  const ru = config.language === 'ru';

  // Averages for this week and last, so the one metrics sentence compares real numbers instead
  // of a figure the model picks off the last day it read.
  try {
    const line = formatWeekAverages(startStr, endStr, ru);
    if (line) parts.push(line);
  } catch (err) {
    logWarn('report.weekly.metric_averages_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  try {
    const credits = queries.getCreditsByDateRange(startStr, endStr);
    if (credits.length) {
      const label = ru
        ? 'Чужие отклики за неделю — ПЕРЕСКАЗ вечернего разбора, не его слова: в кавычки не бери, цитируй только то, что найдёшь в самих записях; упоминай только если есть'
        : "Other people's responses this week — PARAPHRASED by the evening analysis, not their words: never put these in quotation marks, quote only what you find in the entries themselves; mention only if present";
      parts.push(`${label}:\n${credits.slice(0, 12).map((c) => `- ${c.date}: ${c.text}`).join('\n')}`);
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
        ? 'Счётчики паттернов за две недели (фон для наблюдения; в письмо в виде «X → Y» не выносить)'
        : 'Pattern counters for two weeks (background for the observation; never print them as "X → Y")';
      const line = sorted.map((c) => `${c.type} ${c.counts[0]}→${c.counts[1]}`).join(', ');
      parts.push(`${label}: ${line}`);
    }
  } catch (err) {
    logWarn('report.weekly.pattern_counters_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  // Previous letters, so the model can see what it has already observed and say "second week
  // in a row" instead of discovering it again, and what was left hanging. Reports from the
  // retired counter format are stripped of their tallies first, so "5 из 7" and unlabelled
  // metric strings cannot leak into a letter that is forbidden from carrying them.
  try {
    const prev = queries.getReportsByDateRange('weekly', shiftLocalDate(startStr, -21), shiftLocalDate(startStr, -1));
    if (prev.length) {
      const label = ru
        ? 'ПРОШЛЫЕ ПИСЬМА — только чтобы не повторять их наблюдения и видеть, что висит; их формат, счётчики и числа не использовать (если то же видно снова — скажи, что это вторая неделя подряд)'
        : 'PREVIOUS LETTERS — only so you do not repeat their observations and can see what is hanging; never reuse their format, counters or numbers (if the same thing shows again, say it is the second week running)';
      parts.push(`${label}:\n${prev.slice(-2).map((r) => stripLegacyCounters(r.report_text).slice(0, 2600)).join('\n---\n')}`);
    }
  } catch (err) {
    logWarn('report.weekly.previous_reports_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  const veto = buildVetoBlock();
  if (veto) parts.push(veto);

  if (parts.length === 0) return null;
  const header = ru ? '=== ДАННЫЕ НЕДЕЛИ ===' : '=== WEEK DATA ===';
  return `${header}\n${parts.join('\n\n')}`;
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
        ? 'Формат «эксперимент недели» заменён недельным письмом'
        : 'The weekly-experiment format was replaced by the weekly letter',
      end_date: today,
    });
    logInfo('experiment.retired', { experimentId: active.id });
  } catch (err) {
    logWarn('experiment.retire_failed', { reason: err instanceof Error ? err.message : String(err) });
  }
}

// Exported for the scratchpad harness, which runs real weeks against a DB copy.
export async function runWeeklyReport(
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
  const said = transcriptsForRange(startStr, endStr);
  const toDisplay = (raw: string) => enforceVerbatimQuotes(extractReportDisplayText(raw), said);

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

  for (const provider of providers) {
    try {
      await runWithProvider(
        api, target.chatId, context, systemPrompt, title, reportType, startStr, endStr, provider, target.replyToMessageId,
        toDisplay,
      );
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

  // Only the real weekly report (not test runs) touches the legacy experiment table.
  if (reportType === 'weekly') retireLegacyExperiment(todayLocal());
}

/**
 * What the monthly letter may state beyond the entries and the weekly letters: other people's
 * responses over the month, verbatim, and the standing vetoes. The tapped credits, contract
 * tallies and label shares that used to sit here were the bookkeeping he did not read.
 */
function buildMonthlyMechanicsContext(startStr: string, endStr: string): string | null {
  const parts: string[] = [];
  const ru = config.language === 'ru';

  // Week-by-week averages, so "mood by week" is computed rather than eyeballed off the entries.
  try {
    const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;
    const lines: string[] = [];
    for (let s = startStr; s <= endStr; s = shiftLocalDate(s, 7)) {
      let e = shiftLocalDate(s, 6) > endStr ? endStr : shiftLocalDate(s, 6);
      // A tail of one to three days is not a week: fold it into the last full chunk.
      if (e < endStr && daysBetween(shiftLocalDate(e, 1), endStr) <= 3) e = endStr;
      const line = formatWeekAverages(s, e, ru, false);
      if (line) lines.push(`${s} — ${e} (${daysBetween(s, e)} ${ru ? 'дн.' : 'days'}): ${line.slice(line.indexOf(': ') + 2)}`);
      if (e === endStr) break;
    }
    if (lines.length) {
      parts.push((ru ? 'Средние метрики по неделям (по его вечерним оценкам)' : 'Average metrics by week (from their evening ratings)') + ':\n' + lines.join('\n'));
    }
  } catch (err) {
    logWarn('report.monthly.metric_averages_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  try {
    const credits = queries.getCreditsByDateRange(startStr, endStr);
    if (credits.length) {
      const label = ru
        ? 'Чужие отклики за месяц — ПЕРЕСКАЗ вечерних разборов, не его слова: в кавычки не бери, цитируй только то, что найдёшь в самих записях; упоминай только если есть'
        : "Other people's responses this month — PARAPHRASED by the evening analyses, not their words: never put these in quotation marks, quote only what you find in the entries themselves; mention only if present";
      parts.push(`${label}:\n${credits.slice(0, 20).map((c) => `- ${c.date}: ${c.text}`).join('\n')}`);
    }
  } catch (err) {
    logWarn('report.monthly.credits_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  const veto = buildVetoBlock();
  if (veto) parts.push(veto);

  const header = ru ? '=== ДАННЫЕ МЕСЯЦА ===' : '=== MONTH DATA ===';
  return parts.length ? `${header}\n${parts.join('\n\n')}` : null;
}

// Exported for the scratchpad harness, which runs real months against a DB copy.
export async function runMonthlyReport(
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

  // Transcripts included while they fit: the letter quotes him verbatim, and the compact form
  // (analyses only) gives it nothing to quote from.
  if (summaries.length > 0) {
    parts.push('=== Daily Entries ===');
    const headLen = parts.join('\n\n---\n\n').length;
    parts.push(fitContext(summaries, MAX_CONTEXT_CHARS - headLen));
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
  const said = transcriptsForRange(startStr, endStr);
  const toDisplay = (raw: string) => enforceVerbatimQuotes(extractReportDisplayText(raw), said);

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
      await runWithProvider(api, target.chatId, fullContext, systemPrompt, title, reportType, startStr, endStr, provider, target.replyToMessageId, toDisplay);
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
