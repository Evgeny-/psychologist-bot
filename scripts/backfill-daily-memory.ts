/**
 * Backfill daily_memory summaries for days that predate the daily-memory mechanism.
 * For each day that has entries but no summary, rebuilds the compressed day summary
 * (transcripts + analyses + threads + metrics) via the configured LLM.
 *
 * Usage (prefer a cheaper model for bulk compression):
 *   OPENAI_LLM_MODEL=gpt-5.6-terra LLM_REASONING_EFFORT=low npx tsx scripts/backfill-daily-memory.ts
 *
 * Idempotent: only fills missing dates, existing summaries are never touched.
 */
import { queries, db } from '../src/db/index.js';
import { consolidateDailyMemoryForDate } from '../src/services/daily-memory.js';

const missing = db.prepare(`
  SELECT DISTINCT e.date FROM entries e
  LEFT JOIN daily_memory dm ON dm.date = e.date
  WHERE dm.date IS NULL
  ORDER BY e.date ASC
`).all() as Array<{ date: string }>;

console.log(`Missing day summaries: ${missing.length}`);

let done = 0;
for (const { date } of missing) {
  try {
    await consolidateDailyMemoryForDate(date);
    done++;
    const row = queries.getDailyMemoryByDateRange(date, date)[0];
    console.log(`[${done}/${missing.length}] ${date} ${row ? `ok (${row.summary.length} chars)` : 'EMPTY'}`);
  } catch (err) {
    console.error(`[${done}/${missing.length}] ${date} FAILED: ${err instanceof Error ? err.message : err}`);
  }
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`Done: ${done}/${missing.length}`);
process.exit(0);
