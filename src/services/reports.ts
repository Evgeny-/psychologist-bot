import type { Api } from 'grammy';
import { createLLMProvider, createAllLLMProviders, type LLMProvider } from '../providers/llm/index.js';
import { getWeeklySystemPrompt } from '../prompts/weekly.js';
import { getMonthlySystemPrompt } from '../prompts/monthly.js';
import { getMorningSystemPrompt } from '../prompts/morning.js';
import { config } from '../config.js';
import { t } from '../i18n/index.js';
import { queries } from '../db/index.js';
import type { MetricsRow } from '../db/queries.js';
import { sendSplitMessages, sendRawHtmlMessages, markdownToHtml, postChannelHeader } from '../utils/telegram.js';
import { formatDateLocal, shiftLocalDate, todayLocal } from '../utils/date.js';
import { getMemoryUpdatePrompt, MEMORY_MAX_LENGTH } from '../prompts/memory.js';
import { sendMetricsChart } from './charts.js';
import { getDistortionCounts } from './patterns.js';
import { sendAudioReply } from './audio-replies.js';
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

interface MorningBriefEnvelope {
  message?: string | null;
  skip?: boolean;
  grounding?: string[];
}

interface WeeklyExperimentResult {
  status?: 'done' | 'skipped';
  note?: string;
}

interface WeeklyNextExperiment {
  text?: string;
  success_criterion?: string;
  target_count?: number;
}

interface WeeklyReportEnvelope {
  report_text?: string;
  experiment_result?: WeeklyExperimentResult | null;
  next_experiment?: WeeklyNextExperiment | null;
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

function parseJsonEnvelope<T>(text: string): T | null {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonText = match ? match[1] : text;
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    return null;
  }
}

function parseMorningBriefJson(text: string): MorningBriefEnvelope | null {
  return parseJsonEnvelope<MorningBriefEnvelope>(text);
}

function parseMorningBriefText(text: string): string {
  const parsed = parseMorningBriefJson(text);
  if (typeof parsed?.message === 'string' && parsed.message.trim()) {
    return parsed.message.trim();
  }
  return text.replace(/```json\s*[\s\S]*?\s*```/, '').trim() || text.trim();
}

/** Day-of-week "genre" hint for the morning brief, chosen by weekday. */
function morningGenreForDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  const ru = [
    'связь с людьми / благодарность',            // Sun
    'фокус недели + эксперимент',                 // Mon
    'вопрос дня',                                 // Tue
    'микро-действие на сегодня',                  // Wed
    'за каким паттерном понаблюдать',             // Thu
    'уязвимая зона вечера/выходных по твоим данным', // Fri
    'тело и ресурс',                              // Sat
  ];
  const en = [
    'connection with people / gratitude',         // Sun
    'week focus + experiment',                    // Mon
    'question of the day',                        // Tue
    'micro-action for today',                     // Wed
    'which pattern to watch',                     // Thu
    'vulnerable zone of the evening/weekend from your data', // Fri
    'body and resource',                          // Sat
  ];
  return config.language === 'ru' ? ru[weekday] : en[weekday];
}

function averageMetric(rows: MetricsRow[], key: keyof MetricsRow): number | null {
  const values = rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function formatMetricNum(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Compact per-day metrics trend for the last 7 days ending at `endDate`. */
function buildMetricsTrendBlock(endDate: string): string | null {
  const startDate = shiftLocalDate(endDate, -6);
  const rows = queries.getMetricsByDateRange(startDate, endDate);
  if (rows.length === 0) return null;

  const byDate = new Map<string, MetricsRow[]>();
  for (const row of rows) {
    const existing = byDate.get(row.date);
    if (existing) existing.push(row);
    else byDate.set(row.date, [row]);
  }

  const lines: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const date = shiftLocalDate(endDate, -i);
    const dayRows = byDate.get(date);
    if (!dayRows || dayRows.length === 0) continue;
    const parts: string[] = [];
    const mood = averageMetric(dayRows, 'mood');
    const anxiety = averageMetric(dayRows, 'anxiety');
    const stress = averageMetric(dayRows, 'stress');
    const productivity = averageMetric(dayRows, 'productivity');
    const routine = averageMetric(dayRows, 'routine');
    if (mood !== null) parts.push(`mood ${formatMetricNum(mood)}`);
    if (anxiety !== null) parts.push(`anx ${formatMetricNum(anxiety)}`);
    if (stress !== null) parts.push(`str ${formatMetricNum(stress)}`);
    if (productivity !== null) parts.push(`prod ${formatMetricNum(productivity)}`);
    if (routine !== null) parts.push(`rout ${formatMetricNum(routine)}`);
    if (parts.length > 0) lines.push(`[${date}] ${parts.join(' · ')}`);
  }
  if (lines.length === 0) return null;

  const header = config.language === 'ru'
    ? 'Тренд метрик за 7 дней (по дням)'
    : '7-day metrics trend (by day)';
  return `${header}:\n${lines.join('\n')}`;
}

/** Intervention context for the morning brief: experiment, intentions, trend, patterns, genre. */
function buildMorningInterventionBlock(today: string, yesterday: string): string {
  const parts: string[] = [];

  try {
    const active = queries.getActiveExperiment();
    if (active) {
      const target = active.target_count ?? '—';
      const criterion = active.success_criterion ?? '—';
      parts.push(config.language === 'ru'
        ? `Активный эксперимент недели: ${active.text}. Критерий: ${criterion}. Прогресс: ${active.progress_count}/${target}`
        : `Active weekly experiment: ${active.text}. Criterion: ${criterion}. Progress: ${active.progress_count}/${target}`);
    }
  } catch { /* fail-soft */ }

  try {
    const intentions = queries.getActionItemsForDate(yesterday).slice(0, 5);
    if (intentions.length > 0) {
      const label = config.language === 'ru' ? 'Вчерашние намерения' : "Yesterday's intentions";
      parts.push(`${label}:\n${intentions.map((i) => `- ${i}`).join('\n')}`);
    }
  } catch { /* fail-soft */ }

  try {
    const trend = buildMetricsTrendBlock(yesterday);
    if (trend) parts.push(trend);
  } catch { /* fail-soft */ }

  try {
    const patterns = getDistortionCounts().slice(0, 3);
    if (patterns.length > 0) {
      const label = config.language === 'ru'
        ? 'Топ паттернов (всего / за 30 дней)'
        : 'Top patterns (total / last 30 days)';
      parts.push(`${label}:\n${patterns.map((p) => `${p.type}: ${p.total} / ${p.last30}`).join('\n')}`);
    }
  } catch { /* fail-soft */ }

  const genreLabel = config.language === 'ru' ? 'Жанр дня (подсказка формата)' : 'Genre of the day (format hint)';
  parts.push(`${genreLabel}: ${morningGenreForDate(today)}`);

  const header = config.language === 'ru' ? '=== ФОКУС И ДАННЫЕ ДЛЯ ИНТЕРВЕНЦИИ ===' : '=== FOCUS AND DATA FOR THE INTERVENTION ===';
  return `${header}\n${parts.join('\n\n')}`;
}

function buildMorningBriefContext(today: string): { yesterday: string; context: string; hasYesterdayData: boolean } {
  const yesterday = shiftLocalDate(today, -1);
  const dayBefore = shiftLocalDate(today, -2);
  const yesterdaySummaries = buildDaySummaries(yesterday, yesterday);

  if (yesterdaySummaries.length === 0) {
    return { yesterday, context: '', hasYesterdayData: false };
  }

  const primaryContext = fitContext(yesterdaySummaries, MAX_CONTEXT_CHARS - 60_000);
  const parts = [
    `Today morning date: ${today}`,
    `Primary source day: ${yesterday}`,
    buildMorningInterventionBlock(today, yesterday),
    `=== YESTERDAY (${yesterday}) ===\n${primaryContext}`,
  ];

  const dayBeforeSummaries = buildDaySummaries(dayBefore, dayBefore);
  if (dayBeforeSummaries.length > 0) {
    const secondaryContext = formatSummariesCompact(dayBeforeSummaries).slice(0, 60_000);
    parts.push(`=== DAY BEFORE YESTERDAY (${dayBefore}) ===\n${secondaryContext}`);
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
  return parseJsonEnvelope<WeeklyReportEnvelope>(text);
}

/** Pull the human-readable report body out of the weekly JSON envelope (fail-soft). */
function extractWeeklyDisplayText(raw: string): string {
  const env = parseWeeklyEnvelope(raw);
  if (env && typeof env.report_text === 'string' && env.report_text.trim()) {
    return env.report_text.trim();
  }
  return raw.replace(/```json\s*[\s\S]*?\s*```/, '').trim() || raw.trim();
}

/** This-week vs last-week distortion counters + active experiment context for the weekly report. */
function buildWeeklyExperimentContext(startStr: string, endStr: string): string | null {
  const parts: string[] = [];

  try {
    const active = queries.getActiveExperiment();
    if (active) {
      const events = queries.getExperimentEventsSince(active.id, startStr);
      const target = active.target_count ?? '—';
      const criterion = active.success_criterion ?? '—';
      const eventNotes = events
        .map((e) => (e.note ? `- ${e.note}` : null))
        .filter((n): n is string => n !== null)
        .slice(0, 10);
      const lines = [
        config.language === 'ru'
          ? `Активный эксперимент: ${active.text}. Критерий: ${criterion}. Прогресс: ${active.progress_count}/${target}. Событий за неделю: ${events.length}.`
          : `Active experiment: ${active.text}. Criterion: ${criterion}. Progress: ${active.progress_count}/${target}. Events this week: ${events.length}.`,
      ];
      if (eventNotes.length > 0) lines.push(eventNotes.join('\n'));
      parts.push(lines.join('\n'));
    }
  } catch (err) {
    logWarn('report.weekly.experiment_context_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  try {
    const prevStart = shiftLocalDate(startStr, -7);
    const prevEnd = shiftLocalDate(startStr, -1);
    const rows = queries.getAnalysesWithDistortions();
    const counts = new Map<string, { cur: number; prev: number }>();
    for (const row of rows) {
      const date = (row.created_at || '').slice(0, 10);
      const inCur = date >= startStr && date <= endStr;
      const inPrev = date >= prevStart && date <= prevEnd;
      if (!inCur && !inPrev) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(row.distortions_json); } catch { continue; }
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        const rawType = item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string'
          ? (item as { type: string }).type : null;
        if (!rawType) continue;
        const type = rawType.replace(/\s+/g, ' ').trim().toLowerCase();
        if (!type) continue;
        const bucket = counts.get(type) ?? { cur: 0, prev: 0 };
        if (inCur) bucket.cur += 1;
        if (inPrev) bucket.prev += 1;
        counts.set(type, bucket);
      }
    }
    if (counts.size > 0) {
      const sorted = Array.from(counts.entries())
        .sort((a, b) => (b[1].cur + b[1].prev) - (a[1].cur + a[1].prev))
        .slice(0, 7);
      const label = config.language === 'ru'
        ? 'Счётчики паттернов (прошлая неделя → эта неделя)'
        : 'Pattern counters (last week → this week)';
      const line = sorted.map(([type, c]) => `${type} ${c.prev}→${c.cur}`).join(', ');
      parts.push(`${label}: ${line}`);
    }
  } catch (err) {
    logWarn('report.weekly.pattern_counters_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  if (parts.length === 0) return null;
  const header = config.language === 'ru' ? '=== ЭКСПЕРИМЕНТ И ПАТТЕРНЫ НЕДЕЛИ ===' : '=== WEEK EXPERIMENT AND PATTERNS ===';
  return `${header}\n${parts.join('\n\n')}`;
}

/** Close the active experiment and/or start the next one, based on the weekly envelope. */
function applyWeeklyExperiment(env: WeeklyReportEnvelope, today: string): void {
  try {
    const active = queries.getActiveExperiment();
    const result = env.experiment_result;
    const next = env.next_experiment;
    const hasNext = !!(next && typeof next.text === 'string' && next.text.trim());

    if (active) {
      if (result && (result.status === 'done' || result.status === 'skipped')) {
        queries.closeExperiment(active.id, {
          status: result.status,
          result_note: typeof result.note === 'string' ? result.note : undefined,
          end_date: today,
        });
        logInfo('experiment.weekly.closed', { experimentId: active.id, status: result.status });
      } else if (hasNext) {
        // Rolling over to a new experiment — auto-close the old one to avoid two active.
        queries.closeExperiment(active.id, {
          status: 'skipped',
          result_note: config.language === 'ru' ? 'Авто-закрыт при смене эксперимента' : 'Auto-closed at experiment rollover',
          end_date: today,
        });
        logInfo('experiment.weekly.auto_closed', { experimentId: active.id });
      }
    }

    if (hasNext && next) {
      const id = queries.insertExperiment({
        text: next.text!.trim(),
        success_criterion: typeof next.success_criterion === 'string' ? next.success_criterion : undefined,
        target_count: typeof next.target_count === 'number' ? next.target_count : undefined,
        start_date: today,
      });
      logInfo('experiment.weekly.created', { experimentId: id, targetCount: next.target_count });
    }
  } catch (err) {
    logWarn('experiment.weekly.apply_failed', { reason: err instanceof Error ? err.message : String(err) });
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
  const experimentContext = buildWeeklyExperimentContext(startStr, endStr);
  const context = experimentContext ? `${experimentContext}\n\n---\n\n${baseContext}` : baseContext;
  const systemPrompt = buildSystemPromptWithMemory(getWeeklySystemPrompt(config.language));

  const strings = t();
  const prefix = reportType === 'test_weekly' ? '🧪 TEST ' : '';
  const title = prefix + strings.weeklyReportTitle
    .replace('{start}', startStr)
    .replace('{end}', endStr);

  // Post short header to channel, get comment target for full content
  const target = await postChannelHeader(api, chatId, config.telegram.discussionGroupId, `${title}\n\n#bot`);

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
    logWarn('report.weekly.experiment_fallback_envelope', {
      reportType,
      configuredPrimary: config.llm.provider,
    });
  }
  if (reportType === 'weekly' && effectiveEnvelope) {
    applyWeeklyExperiment(effectiveEnvelope, todayLocal());
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

  const systemPrompt = buildSystemPromptWithMemory(getMonthlySystemPrompt(config.language));

  const strings = t();
  const prefix = reportType === 'test_monthly' ? '🧪 TEST ' : '';
  const title = prefix + strings.monthlyReportTitle
    .replace('{start}', startStr)
    .replace('{end}', endStr);

  // Post short header to channel, get comment target for full content
  const target = await postChannelHeader(api, chatId, config.telegram.discussionGroupId, `${title}\n\n#bot`);

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

async function runMorningBrief(
  api: Api,
  chatId: number,
  today: string,
  reportType: 'morning_brief' | 'test_morning_brief',
): Promise<void> {
  const strings = t();
  const prefix = reportType === 'test_morning_brief' ? '🧪 TEST ' : '';
  const title = `${prefix}${strings.morningBriefTitle}`;

  const { yesterday, context, hasYesterdayData } = buildMorningBriefContext(today);
  logInfo('report.morning.start', {
    reportType,
    today,
    yesterday,
    hasYesterdayData,
    contextChars: context.length,
    chatId,
  });

  if (!hasYesterdayData) {
    const message = strings.morningBriefNoEntry;
    queries.insertReport({
      type: reportType,
      period_start: yesterday,
      period_end: today,
      report_text: message,
    });
    const body = markdownToHtml(message);
    await sendRawHtmlMessages(api, chatId, `<blockquote>${title}</blockquote>\n\n${body}\n\n#bot`);
    logWarn('report.morning.no_data', { reportType, today, yesterday, chatId });
    return;
  }

  const systemPrompt = buildSystemPromptWithMemory(getMorningSystemPrompt(config.language));
  const llm = createLLMProvider();
  const start = Date.now();
  const result = await llm.analyze(context, systemPrompt);
  const message = parseMorningBriefText(result.text);
  const parsed = parseMorningBriefJson(result.text);
  if (!parsed) {
    logWarn('report.morning.parse_fallback', {
      reportType,
      today,
      yesterday,
      provider: llm.providerName,
      model: llm.modelName,
      outputChars: result.text.length,
    });
  }

  const isTest = reportType === 'test_morning_brief';
  // grounding comes straight from LLM JSON — guard the type, not just truthiness.
  const groundingList = Array.isArray(parsed?.grounding)
    ? parsed.grounding.filter((g): g is string => typeof g === 'string' && g.trim() !== '')
    : [];
  const skipReason = groundingList.length ? groundingList.join('; ') : 'no concrete focus';
  const parsedMessage = typeof parsed?.message === 'string' ? parsed.message.trim() : '';
  // Treat a parsed envelope with no usable message as a skip too: falling back to the
  // raw model output would dump the literal JSON envelope into the chat.
  const shouldSkip = parsed !== null && (parsed.skip === true || parsedMessage === '');
  if (parsed !== null && parsed.skip !== true && parsedMessage === '') {
    logWarn('report.morning.empty_message', { reportType, today, yesterday, provider: llm.providerName, model: llm.modelName });
  }

  if (shouldSkip && !isTest) {
    // Nothing concrete to intervene on — do NOT send a message, but DO record the run:
    // hasReportForPeriod() is the per-day dedup guard, and without a row a restart
    // would re-trigger the morning brief later the same day.
    queries.insertReport({
      type: reportType,
      period_start: yesterday,
      period_end: today,
      report_text: `(skipped: ${skipReason})`,
      llm_provider: llm.providerName,
      llm_model: llm.modelName,
    });
    logInfo('report.morning.skipped', {
      reportType,
      today,
      yesterday,
      provider: llm.providerName,
      model: llm.modelName,
      groundingCount: groundingList.length,
    });
    return;
  }

  const outgoing = shouldSkip ? `(skip: ${skipReason})` : (parsed !== null ? parsedMessage : message);

  queries.insertReport({
    type: reportType,
    period_start: yesterday,
    period_end: today,
    report_text: outgoing,
    llm_provider: llm.providerName,
    llm_model: llm.modelName,
  });

  const costInfo = result.usage ? ` | $${result.usage.costUsd.toFixed(5)}` : '';
  const body = markdownToHtml(outgoing);
  await sendRawHtmlMessages(api, chatId, `<blockquote>${title}${costInfo}</blockquote>\n\n${body}\n\n#bot`);

  // P2.12: optionally also deliver the morning focus as a voice message.
  if (!shouldSkip && config.morningBriefAudio && outgoing.trim()) {
    await sendAudioReply(api, chatId, outgoing).catch((err) => {
      logWarn('report.morning.audio_failed', { reportType, today, reason: err instanceof Error ? err.message : String(err) });
    });
  }

  logInfo('report.morning.complete', {
    reportType,
    today,
    yesterday,
    provider: llm.providerName,
    model: llm.modelName,
    elapsedMs: Date.now() - start,
    outputChars: outgoing.length,
    skip: shouldSkip,
    audio: !shouldSkip && config.morningBriefAudio,
    groundingCount: parsed?.grounding?.length,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    costUsd: result.usage?.costUsd?.toFixed(5),
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
    const target = await postChannelHeader(api, chatId, config.telegram.discussionGroupId, `${headerText}\n\n#bot`);
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
    const target = await postChannelHeader(api, chatId, config.telegram.discussionGroupId, `${headerText}\n\n#bot`);
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
