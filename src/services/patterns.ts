import type { BotLanguage } from '../config.js';
import { queries } from '../db/index.js';
import { todayLocal, shiftLocalDate } from '../utils/date.js';
import { logWarn } from '../utils/logger.js';

export interface DistortionCount {
  type: string;
  total: number;
  last30: number;
}

function normalizeType(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Count cognitive distortions across all analyses, total and within the last 30 days. */
export function getDistortionCounts(): DistortionCount[] {
  const rows = queries.getAnalysesWithDistortions();
  const cutoff = shiftLocalDate(todayLocal(), -30);

  const totals = new Map<string, { total: number; last30: number }>();

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.distortions_json);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    const rowDate = (row.created_at || '').slice(0, 10);
    const isRecent = rowDate >= cutoff;

    for (const item of parsed) {
      const rawType = item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string'
        ? (item as { type: string }).type
        : null;
      if (!rawType) continue;
      const type = normalizeType(rawType);
      if (!type) continue;

      const bucket = totals.get(type) ?? { total: 0, last30: 0 };
      bucket.total += 1;
      if (isRecent) bucket.last30 += 1;
      totals.set(type, bucket);
    }
  }

  return Array.from(totals.entries())
    .map(([type, counts]) => ({ type, total: counts.total, last30: counts.last30 }))
    .sort((a, b) => b.total - a.total);
}

/** A context block listing the top recurring distortions with total / last-30-day counts. */
export function buildPatternContextBlock(language: BotLanguage): string | null {
  try {
    const counts = getDistortionCounts();
    if (counts.length === 0) return null;

    const top = counts.slice(0, 7);
    const header = language === 'ru'
      ? '--- СТАТИСТИКА ПАТТЕРНОВ (всего / за 30 дней) ---'
      : '--- PATTERN STATISTICS (total / last 30 days) ---';
    const lines = top.map((c) => `${c.type}: ${c.total} / ${c.last30}`);
    return `${header}\n${lines.join('\n')}`;
  } catch (err) {
    logWarn('patterns.context_failed', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
