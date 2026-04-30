import { config } from '../config.js';
import { queries } from '../db/index.js';
import type { MetricsRow } from '../db/queries.js';
import { DAILY_MEMORY_SUMMARY_MAX_LENGTH, RECENT_DAILY_MEMORY_DAYS } from '../prompts/memory.js';
import { shiftLocalDate } from '../utils/date.js';

interface MemoryPromptOptions {
  includeReferenceDate?: boolean;
}

function formatMetricValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMetricsForDate(metrics: MetricsRow[]): string | null {
  const mood = average(metrics.map((m) => m.mood).filter((v): v is number => v !== null));
  const anxiety = average(metrics.map((m) => m.anxiety).filter((v): v is number => v !== null));
  const selfEsteem = average(metrics.map((m) => m.self_esteem).filter((v): v is number => v !== null));
  const productivity = average(metrics.map((m) => m.productivity).filter((v): v is number => v !== null));

  const parts: string[] = [];
  if (mood !== null) parts.push(config.language === 'ru' ? `настроение ${formatMetricValue(mood)}` : `mood ${formatMetricValue(mood)}`);
  if (anxiety !== null) parts.push(config.language === 'ru' ? `тревога ${formatMetricValue(anxiety)}` : `anxiety ${formatMetricValue(anxiety)}`);
  if (selfEsteem !== null) parts.push(config.language === 'ru' ? `самооценка ${formatMetricValue(selfEsteem)}` : `self-esteem ${formatMetricValue(selfEsteem)}`);
  if (productivity !== null) parts.push(config.language === 'ru' ? `продуктивность ${formatMetricValue(productivity)}` : `productivity ${formatMetricValue(productivity)}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

function buildRecentDailyMemoryBlock(referenceDate: string, options: MemoryPromptOptions): string | null {
  const includeReferenceDate = options.includeReferenceDate ?? true;
  const endDate = includeReferenceDate ? referenceDate : shiftLocalDate(referenceDate, -1);
  const startDate = shiftLocalDate(endDate, -(RECENT_DAILY_MEMORY_DAYS - 1));

  const memories = queries.getDailyMemoryByDateRange(startDate, endDate);
  if (memories.length === 0) return null;

  const metrics = queries.getMetricsByDateRange(startDate, endDate);
  const metricsByDate = new Map<string, MetricsRow[]>();
  for (const row of metrics) {
    const existing = metricsByDate.get(row.date);
    if (existing) existing.push(row);
    else metricsByDate.set(row.date, [row]);
  }

  const label = config.language === 'ru'
    ? `--- КРАТКОСРОЧНАЯ ПАМЯТЬ: дневные сводки за последние ${RECENT_DAILY_MEMORY_DAYS} дней (используй как контекст, не упоминай явно) ---`
    : `--- SHORT-TERM MEMORY: daily summaries for the last ${RECENT_DAILY_MEMORY_DAYS} days (use as context, do not mention explicitly) ---`;

  const lines = memories.map((memory) => {
    const summary = memory.summary.replace(/\s+/g, ' ').trim().slice(0, DAILY_MEMORY_SUMMARY_MAX_LENGTH);
    const metricText = formatMetricsForDate(metricsByDate.get(memory.date) ?? []);
    if (!metricText) return `[${memory.date}] ${summary}`;
    const prefix = config.language === 'ru' ? 'метрики' : 'metrics';
    return `[${memory.date}] ${summary} (${prefix}: ${metricText})`;
  });

  return `${label}\n${lines.join('\n')}\n---`;
}

export function sanitizeDailyMemorySummary(summary: string): string {
  return summary.replace(/\s+/g, ' ').trim().slice(0, DAILY_MEMORY_SUMMARY_MAX_LENGTH);
}

export function buildSystemPromptWithUserMemory(
  basePrompt: string,
  referenceDate: string,
  options: MemoryPromptOptions = {},
): string {
  const blocks: string[] = [];
  const memory = queries.getMemory();

  if (memory) {
    const label = config.language === 'ru'
      ? '--- ПАМЯТЬ О ПОЛЬЗОВАТЕЛЕ (используй как контекст, не упоминай явно) ---'
      : '--- USER MEMORY (use as context, do not mention explicitly) ---';
    blocks.push(`${label}\n${memory}\n---`);
  }

  const recentDailyMemory = buildRecentDailyMemoryBlock(referenceDate, options);
  if (recentDailyMemory) blocks.push(recentDailyMemory);

  if (blocks.length === 0) return basePrompt;
  return `${basePrompt}\n\n${blocks.join('\n\n')}`;
}
