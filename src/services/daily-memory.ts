import type { Api } from 'grammy';
import { config } from '../config.js';
import { queries } from '../db/index.js';
import type { AnalysisRow, EntryRow, MetricsRow, ThreadMessageRow } from '../db/queries.js';
import { createLLMProvider, type LLMProvider } from '../providers/llm/index.js';
import {
  DAILY_MEMORY_SUMMARY_MAX_LENGTH,
  RECENT_DAILY_MEMORY_DAYS,
  getDailyMemorySummaryPrompt,
} from '../prompts/memory.js';
import { markdownToHtml, postChannelHeader, sendRawHtmlMessages, sendSplitMessages } from '../utils/telegram.js';
import { shiftLocalDate, todayLocal } from '../utils/date.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';
import { sanitizeDailyMemorySummary } from './memory-context.js';

interface DailyMemorySummaryEnvelope {
  summary?: string;
}

function parseDailyMemorySummaryJson(text: string): DailyMemorySummaryEnvelope | null {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonText = match ? match[1] : text;
  try {
    return JSON.parse(jsonText) as DailyMemorySummaryEnvelope;
  } catch {
    return null;
  }
}

function parseJsonList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'type' in item && typeof item.type === 'string') return item.type;
        return null;
      })
      .filter((item): item is string => !!item);
  } catch {
    return [];
  }
}

function formatMetrics(rows: MetricsRow[]): string | null {
  const parts: string[] = [];
  for (const row of rows) {
    const metricParts: string[] = [];
    if (row.mood !== null) metricParts.push(`mood=${row.mood}`);
    if (row.anxiety !== null) metricParts.push(`anxiety=${row.anxiety}`);
    if (row.self_esteem !== null) metricParts.push(`self_esteem=${row.self_esteem}`);
    if (row.productivity !== null) metricParts.push(`productivity=${row.productivity}`);
    if (metricParts.length > 0) {
      const entryLabel = row.entry_id ? `entry ${row.entry_id}` : 'day';
      parts.push(`${entryLabel}: ${metricParts.join(', ')}`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function formatThreadFollowUp(messages: ThreadMessageRow[]): string | null {
  const firstAssistantIdx = messages.findIndex((m) => m.role === 'assistant');
  if (firstAssistantIdx < 0 || firstAssistantIdx >= messages.length - 1) return null;

  const followUp = messages.slice(firstAssistantIdx + 1);
  if (followUp.length === 0) return null;

  return followUp.map((m) => {
    const label = m.role === 'user' ? 'User' : 'Assistant';
    return `${label}:\n${m.content}`;
  }).join('\n\n');
}

function formatAnalysisMetadata(analysis: AnalysisRow | undefined): string | null {
  if (!analysis) return null;

  const parts: string[] = [];
  if (analysis.sentiment) parts.push(`sentiment=${analysis.sentiment}`);
  const emotions = parseJsonList(analysis.emotions_json);
  if (emotions.length) parts.push(`emotions=${emotions.join(', ')}`);
  const triggers = parseJsonList(analysis.triggers_json);
  if (triggers.length) parts.push(`triggers=${triggers.join('; ')}`);
  const wins = parseJsonList(analysis.wins_json);
  if (wins.length) parts.push(`wins=${wins.join('; ')}`);
  const distortions = parseJsonList(analysis.distortions_json);
  if (distortions.length) parts.push(`distortions=${distortions.join(', ')}`);
  const topics = parseJsonList(analysis.topics_json);
  if (topics.length) parts.push(`topics=${topics.join(', ')}`);

  return parts.length > 0 ? parts.join('\n') : null;
}

function firstAnalysisByEntry(analyses: AnalysisRow[]): Map<number, AnalysisRow> {
  const map = new Map<number, AnalysisRow>();
  for (const analysis of analyses) {
    if (!map.has(analysis.entry_id)) {
      map.set(analysis.entry_id, analysis);
    }
  }
  return map;
}

function getMessagesForEntry(entry: EntryRow, messagesByThread: Map<number, ThreadMessageRow[]>): ThreadMessageRow[] {
  const messages = [
    ...(messagesByThread.get(entry.telegram_message_id) ?? []),
    ...(entry.channel_post_id ? (messagesByThread.get(entry.channel_post_id) ?? []) : []),
  ];
  return messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function buildDailyMemorySourceContext(date: string): { context: string; sourceEntryId: number | null } {
  const entries = queries.getEntriesByDateRange(date, date);
  if (entries.length === 0) return { context: '', sourceEntryId: null };

  const entryIds = entries.map((entry) => entry.id);
  const analyses = firstAnalysisByEntry(queries.getAnalysesByEntryIds(entryIds));
  const metrics = queries.getMetricsByDateRange(date, date);
  const metricsByEntry = new Map<number | null, MetricsRow[]>();
  for (const metric of metrics) {
    const existing = metricsByEntry.get(metric.entry_id);
    if (existing) existing.push(metric);
    else metricsByEntry.set(metric.entry_id, [metric]);
  }

  const threadIds = entries.flatMap((entry) => [
    entry.telegram_message_id,
    ...(entry.channel_post_id ? [entry.channel_post_id] : []),
  ]);
  const messagesByThread = queries.getAllThreadMessages([...new Set(threadIds)]);

  const parts: string[] = [`Date: ${date}`];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const entryParts = [`[Entry ${i + 1}${entry.local_time ? ` at ${entry.local_time}` : ''}]`];
    const transcript = entry.transcript || entry.raw_text;
    if (transcript) entryParts.push(`Transcript:\n${transcript}`);

    const analysis = analyses.get(entry.id);
    if (analysis?.analysis_text) entryParts.push(`Assistant analysis:\n${analysis.analysis_text}`);

    const metadata = formatAnalysisMetadata(analysis);
    if (metadata) entryParts.push(`Structured analysis:\n${metadata}`);

    const entryMetrics = formatMetrics(metricsByEntry.get(entry.id) ?? []);
    if (entryMetrics) entryParts.push(`Metrics:\n${entryMetrics}`);

    const followUp = formatThreadFollowUp(getMessagesForEntry(entry, messagesByThread));
    if (followUp) entryParts.push(`Follow-up conversation:\n${followUp}`);

    parts.push(entryParts.join('\n\n'));
  }

  const unlinkedMetrics = formatMetrics(metricsByEntry.get(null) ?? []);
  if (unlinkedMetrics) parts.push(`Unlinked day metrics:\n${unlinkedMetrics}`);

  return {
    context: parts.join('\n\n---\n\n'),
    sourceEntryId: entries[entries.length - 1].id,
  };
}

async function generateDailyMemoryForDate(date: string, llm: LLMProvider): Promise<string | null> {
  const { context, sourceEntryId } = buildDailyMemorySourceContext(date);
  if (!context || !sourceEntryId) return null;

  const start = Date.now();
  const result = await llm.analyze(context, getDailyMemorySummaryPrompt(config.language));
  const parsed = parseDailyMemorySummaryJson(result.text);
  const summary = sanitizeDailyMemorySummary(parsed?.summary ?? '');

  if (!summary) {
    logWarn('daily_memory.generate.empty_summary', {
      date,
      provider: llm.providerName,
      model: llm.modelName,
      outputChars: result.text.length,
    });
    return null;
  }

  queries.upsertDailyMemory({
    date,
    summary,
    source_entry_id: sourceEntryId,
    llm_provider: llm.providerName,
    llm_model: llm.modelName,
  });

  logInfo('daily_memory.generate.complete', {
    date,
    provider: llm.providerName,
    model: llm.modelName,
    elapsedMs: Date.now() - start,
    contextChars: context.length,
    summaryChars: summary.length,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    costUsd: result.usage?.costUsd?.toFixed(5),
  });

  return summary;
}

function getRecentMemoryRange(): { start: string; end: string } {
  const end = todayLocal();
  return {
    start: shiftLocalDate(end, -(RECENT_DAILY_MEMORY_DAYS - 1)),
    end,
  };
}

export async function showRecentDailyMemory(api: Api, chatId: number): Promise<void> {
  const { start, end } = getRecentMemoryRange();
  const rows = queries.getDailyMemoryByDateRange(start, end);

  if (rows.length === 0) {
    const message = config.language === 'ru'
      ? 'Краткосрочная память пока пуста.\n\n#bot'
      : 'Short-term memory is empty.\n\n#bot';
    await sendSplitMessages(api, chatId, message);
    return;
  }

  const header = `🧠 Recent memory (${rows.length}/${RECENT_DAILY_MEMORY_DAYS}, ${start} — ${end})\n\n#bot`;
  const target = await postChannelHeader(api, chatId, config.telegram.discussionGroupId, header);
  const body = rows
    .map((row) => `[${row.date}] ${row.summary} (${row.summary.length}/${DAILY_MEMORY_SUMMARY_MAX_LENGTH})`)
    .join('\n\n');
  await sendRawHtmlMessages(api, target.chatId, `${markdownToHtml(body)}\n\n#bot`, target.replyToMessageId);
}

export async function generateRecentDailyMemory(api: Api, chatId: number): Promise<void> {
  const { start, end } = getRecentMemoryRange();
  const entries = queries.getEntriesByDateRange(start, end);
  const dates = [...new Set(entries.map((entry) => entry.date))].sort();

  if (dates.length === 0) {
    const message = config.language === 'ru'
      ? `Нет записей за ${start} — ${end}; краткосрочную память не из чего генерировать.\n\n#bot`
      : `No entries for ${start} — ${end}; nothing to generate short-term memory from.\n\n#bot`;
    await sendSplitMessages(api, chatId, message);
    return;
  }

  const llm = createLLMProvider();
  const generated: Array<{ date: string; summary: string }> = [];

  for (const date of dates) {
    try {
      const summary = await generateDailyMemoryForDate(date, llm);
      if (summary) generated.push({ date, summary });
    } catch (err) {
      logError('daily_memory.generate.failed', err, {
        date,
        provider: llm.providerName,
        model: llm.modelName,
      });
    }
  }

  if (generated.length === 0) {
    const message = config.language === 'ru'
      ? `Не удалось сгенерировать краткосрочную память за ${start} — ${end}.\n\n#bot`
      : `Could not generate short-term memory for ${start} — ${end}.\n\n#bot`;
    await sendSplitMessages(api, chatId, message);
    return;
  }

  const header = `🧠 Recent memory generated (${generated.length}/${dates.length}, ${start} — ${end})\n\n#bot`;
  const target = await postChannelHeader(api, chatId, config.telegram.discussionGroupId, header);
  const body = generated.map((row) => `[${row.date}] ${row.summary}`).join('\n\n');
  await sendRawHtmlMessages(api, target.chatId, `${markdownToHtml(body)}\n\n#bot`, target.replyToMessageId);
}
