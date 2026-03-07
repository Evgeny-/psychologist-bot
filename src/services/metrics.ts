import { t } from '../i18n/index.js';

export interface ParsedMetrics {
  mood?: number;
  anxiety?: number;
  self_esteem?: number;
  productivity?: number;
  custom: Record<string, number>;
}

export function parseMetrics(text: string): ParsedMetrics {
  const patterns = t().metricsPatterns;
  const result: ParsedMetrics = { custom: {} };

  const lower = text.toLowerCase();

  result.mood = findMetricValue(lower, patterns.mood);
  result.anxiety = findMetricValue(lower, patterns.anxiety);
  result.self_esteem = findMetricValue(lower, patterns.self_esteem);
  result.productivity = findMetricValue(lower, patterns.productivity);

  return result;
}

function findMetricValue(text: string, aliases: readonly string[]): number | undefined {
  for (const alias of aliases) {
    // Match patterns like "настроение 7", "н7", "mood 7", "m7", "настроение: 7"
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escaped}[:\\s]*([0-9]|10)(?:\\b|$)`, 'i');
    const match = text.match(regex);
    if (match) {
      const val = parseInt(match[1], 10);
      if (val >= 0 && val <= 10) return val;
    }
  }
  return undefined;
}

export function hasAnyMetrics(metrics: ParsedMetrics): boolean {
  return metrics.mood !== undefined || metrics.anxiety !== undefined || metrics.self_esteem !== undefined || metrics.productivity !== undefined;
}
