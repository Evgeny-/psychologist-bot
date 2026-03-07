import type { Api } from 'grammy';
import { createLLMProvider, createAllLLMProviders, type LLMProvider } from '../providers/llm/index.js';
import { getWeeklySystemPrompt } from '../prompts/weekly.js';
import { getMonthlySystemPrompt } from '../prompts/monthly.js';
import { config } from '../config.js';
import { t } from '../i18n/index.js';
import { queries } from '../db/index.js';
import { sendSplitMessages, sendRawHtmlMessages, markdownToHtml } from '../utils/telegram.js';
import { formatDateLocal } from '../utils/date.js';

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

interface DaySummary {
  date: string;
  transcript: string | null;
  llmResponse: string | null;
  metrics: string | null;
}

function buildDaySummaries(start: string, end: string): DaySummary[] {
  const entries = queries.getEntriesByDateRange(start, end);
  const metrics = queries.getMetricsByDateRange(start, end);

  const threadIds = entries.map((e) => e.telegram_message_id);
  const llmResponses = queries.getFirstAssistantMessages(threadIds);

  const summaries: DaySummary[] = [];

  for (const entry of entries) {
    const transcript = entry.transcript || entry.raw_text || null;
    const llmResponse = llmResponses.get(entry.telegram_message_id) ?? null;

    const dayMetrics = metrics.find((m) => m.date === entry.date);
    let metricsStr: string | null = null;
    if (dayMetrics) {
      const m: string[] = [];
      if (dayMetrics.mood !== null) m.push(`mood=${dayMetrics.mood}`);
      if (dayMetrics.anxiety !== null) m.push(`anxiety=${dayMetrics.anxiety}`);
      if (dayMetrics.energy !== null) m.push(`energy=${dayMetrics.energy}`);
      if (m.length) metricsStr = m.join(', ');
    }

    summaries.push({ date: entry.date, transcript, llmResponse, metrics: metricsStr });
  }

  return summaries;
}

function formatSummariesFull(summaries: DaySummary[]): string {
  return summaries.map((s) => {
    const parts = [`[${s.date}]`];
    if (s.transcript) parts.push(`Transcript:\n${s.transcript}`);
    if (s.llmResponse) parts.push(`LLM Analysis:\n${s.llmResponse}`);
    if (s.metrics) parts.push(`Metrics: ${s.metrics}`);
    return parts.join('\n\n');
  }).join('\n\n---\n\n');
}

function formatSummariesCompact(summaries: DaySummary[]): string {
  return summaries.map((s) => {
    const parts = [`[${s.date}]`];
    if (s.llmResponse) parts.push(`LLM Analysis:\n${s.llmResponse}`);
    else if (s.transcript) parts.push(`(transcript available, omitted for brevity)`);
    if (s.metrics) parts.push(`Metrics: ${s.metrics}`);
    return parts.join('\n\n');
  }).join('\n\n---\n\n');
}

function fitContext(summaries: DaySummary[], maxChars: number): string {
  const full = formatSummariesFull(summaries);
  if (full.length <= maxChars) return full;
  return formatSummariesCompact(summaries);
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
): Promise<void> {
  const start = Date.now();
  const result = await provider.analyze(context, systemPrompt);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  queries.insertReport({
    type: reportType,
    period_start: startStr,
    period_end: endStr,
    report_text: result.text,
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
  const body = markdownToHtml(result.text.trim());
  await sendRawHtmlMessages(api, chatId, `${meta}\n\n${body}\n\n#bot`, replyToMessageId);
}

async function runWeeklyReport(
  api: Api,
  chatId: number,
  startStr: string,
  endStr: string,
  reportType: 'weekly' | 'test_weekly',
  replyToMessageId?: number,
): Promise<void> {
  const summaries = buildDaySummaries(startStr, endStr);
  if (summaries.length === 0) {
    await sendSplitMessages(api, chatId, `No entries found for ${startStr} — ${endStr}\n\n#bot`, replyToMessageId);
    return;
  }

  const context = fitContext(summaries, MAX_CONTEXT_CHARS);
  const systemPrompt = getWeeklySystemPrompt(config.language);

  const strings = t();
  const prefix = reportType === 'test_weekly' ? '🧪 TEST ' : '';
  const title = prefix + strings.weeklyReportTitle
    .replace('{start}', startStr)
    .replace('{end}', endStr);

  const providers = config.compareMode ? createAllLLMProviders() : [createLLMProvider()];

  for (const provider of providers) {
    try {
      await runWithProvider(api, chatId, context, systemPrompt, title, reportType, startStr, endStr, provider, replyToMessageId);
    } catch (err) {
      const label = `${provider.providerName} (${provider.modelName})`;
      const errMsg = err instanceof Error ? err.message : String(err);
      await sendRawHtmlMessages(api, chatId, `<blockquote>${title}\n${label}</blockquote>\n\nError: ${errMsg}\n\n#bot`, replyToMessageId);
    }
  }
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

  if (summaries.length === 0 && allWeeklyReports.length === 0) {
    await sendSplitMessages(api, chatId, `No entries found for ${startStr} — ${endStr}\n\n#bot`);
    return;
  }

  const parts: string[] = [];

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

  const systemPrompt = getMonthlySystemPrompt(config.language);

  const strings = t();
  const prefix = reportType === 'test_monthly' ? '🧪 TEST ' : '';
  const title = prefix + strings.monthlyReportTitle
    .replace('{start}', startStr)
    .replace('{end}', endStr);

  const providers = config.compareMode ? createAllLLMProviders() : [createLLMProvider()];

  for (const provider of providers) {
    try {
      await runWithProvider(api, chatId, fullContext, systemPrompt, title, reportType, startStr, endStr, provider);
    } catch (err) {
      const label = `${provider.providerName} (${provider.modelName})`;
      const errMsg = err instanceof Error ? err.message : String(err);
      await sendRawHtmlMessages(api, chatId, `<blockquote>${title}\n${label}</blockquote>\n\nError: ${errMsg}\n\n#bot`);
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
