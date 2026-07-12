import { config } from '../config.js';
import { queries } from '../db/index.js';
import { getOrbitTheme } from '../prompts/orbits.js';
import { shiftLocalDate } from '../utils/date.js';
import { logWarn } from '../utils/logger.js';

/** Look-back window for counting theme repeats. */
export const ORBIT_WINDOW_DAYS = 45;
/** A theme becomes an "active orbit" once it appears on this many distinct days in the window. */
export const ORBIT_MIN_DAYS = 2;
/** At most this many orbit lines in the context block. */
const ORBIT_MAX_LINES = 4;

/**
 * Build the "active orbits" context block: recurring themes of the last weeks with
 * deterministic day counts and (when seeded) per-user historical notes. The system
 * prompt instructs the model to switch register when the current entry continues
 * one of these orbits — name the repetition instead of re-analyzing it.
 *
 * Returns null when nothing recurs (or on any error — the block is optional context).
 */
export function buildOrbitContextBlock(date: string, excludeEntryId?: number): string | null {
  try {
    const since = shiftLocalDate(date, -ORBIT_WINDOW_DAYS);
    const rows = queries.getOrbitActivitySince(since, excludeEntryId);
    if (rows.length === 0) return null;

    const byTheme = new Map<string, Set<string>>();
    for (const row of rows) {
      if (row.date > date) continue; // eval harness can replay past entries
      if (!getOrbitTheme(row.theme)) continue;
      let dates = byTheme.get(row.theme);
      if (!dates) byTheme.set(row.theme, (dates = new Set()));
      dates.add(row.date);
    }

    const active = [...byTheme.entries()]
      .map(([theme, dates]) => ({ theme, dates: [...dates].sort() }))
      .filter((t) => t.dates.length >= ORBIT_MIN_DAYS)
      .sort((a, b) => b.dates.length - a.dates.length)
      .slice(0, ORBIT_MAX_LINES);
    if (active.length === 0) return null;

    const notes = queries.getOrbitMetaNotes();
    const ru = config.language === 'ru';

    const lines = active.map(({ theme, dates }) => {
      const def = getOrbitTheme(theme)!;
      const label = ru ? def.label.ru : def.label.en;
      const recent = dates.slice(-3).map((d) => d.slice(5)).join(', ');
      const count = ru
        ? `${dates.length} дн. за ${ORBIT_WINDOW_DAYS} (последние: ${recent})`
        : `${dates.length} days in ${ORBIT_WINDOW_DAYS} (latest: ${recent})`;
      const note = notes.get(theme);
      return `- [${theme}] ${label} — ${count}${note ? `. ${note}` : ''}`;
    });

    const header = ru
      ? '--- АКТИВНЫЕ ОРБИТЫ (повторяющиеся темы последних недель; правила работы с ними — в системном промпте) ---'
      : '--- ACTIVE ORBITS (recurring themes of recent weeks; handling rules are in the system prompt) ---';
    return `${header}\n${lines.join('\n')}`;
  } catch (err) {
    logWarn('orbits.context_failed', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
