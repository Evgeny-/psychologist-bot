import type { MetricsRow } from '../db/queries.js';

/** Compact numeric display: integers render bare ("7"), fractions with one decimal ("6.5"). */
export function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export type MetricKey = 'mood' | 'anxiety' | 'stress' | 'productivity' | 'routine';

/** Average of one metric column across rows, ignoring nulls. Null when no values. */
export function averageMetric(rows: MetricsRow[], key: MetricKey): number | null {
  return average(rows.map((row) => row[key]).filter((value): value is number => typeof value === 'number'));
}
