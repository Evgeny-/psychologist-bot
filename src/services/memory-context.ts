import { config } from '../config.js';
import { queries } from '../db/index.js';
import type { MetricsRow } from '../db/queries.js';
import { DAILY_MEMORY_SUMMARY_MAX_LENGTH, RECENT_DAILY_MEMORY_DAYS } from '../prompts/memory.js';
import { shiftLocalDate } from '../utils/date.js';
import { averageMetric, formatCompactNumber } from '../utils/format.js';

interface MemoryPromptOptions {
  includeReferenceDate?: boolean;
}

function formatMetricsForDate(metrics: MetricsRow[]): string | null {
  const mood = averageMetric(metrics, 'mood');
  const anxiety = averageMetric(metrics, 'anxiety');
  const stress = averageMetric(metrics, 'stress');
  const productivity = averageMetric(metrics, 'productivity');
  const routine = averageMetric(metrics, 'routine');

  const parts: string[] = [];
  if (mood !== null) parts.push(config.language === 'ru' ? `настроение ${formatCompactNumber(mood)}` : `mood ${formatCompactNumber(mood)}`);
  if (anxiety !== null) parts.push(config.language === 'ru' ? `тревога ${formatCompactNumber(anxiety)}` : `anxiety ${formatCompactNumber(anxiety)}`);
  if (stress !== null) parts.push(config.language === 'ru' ? `стресс ${formatCompactNumber(stress)}` : `stress ${formatCompactNumber(stress)}`);
  if (productivity !== null) parts.push(config.language === 'ru' ? `продуктивность ${formatCompactNumber(productivity)}` : `productivity ${formatCompactNumber(productivity)}`);
  if (routine !== null) parts.push(config.language === 'ru' ? `рутина ${formatCompactNumber(routine)}` : `routine ${formatCompactNumber(routine)}`);
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
