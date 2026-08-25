#!/usr/bin/env node
// Compute the quantitative side of the deep report from the raw export.
// This is the ONLY script that touches numeric metrics/counts - all narrative
// content comes from the per-week subagent summaries (see SKILL.md step 4).
//
// Usage:
//   node compute-stats.mjs --entries export/entries.json \
//                           --analyses export/analyses.json \
//                           --metrics export/metrics.json \
//                           --out export/stats.json
//
// Output shape (stats.json):
//   {
//     series: [{ date, mood, anxiety, stress, productivity, routine }, ...],
//     coverage: { mood: n, anxiety: n, ... },              // non-null day count per metric
//     monthly: [{ month: "YYYY-MM", mood, anxiety, stress, productivity, routine, days }, ...],
//     sentMonthly: { "YYYY-MM": { positive, neutral, negative, total } },
//     topThemes: [[name, count], ...],       // from analyses.topics_json, all distinct values
//     topEmotions: [[name, count], ...],     // from analyses.emotions_json
//     topDistortions: [[name, count], ...],  // from analyses.distortions_json (see note below)
//     distortionsByMonth: { "YYYY-MM": [[name, count], ...] },
//     orbits: [[theme_key, uniqueDays], ...],          // from analyses.orbit_themes_json
//     orbitsByMonth: { "YYYY-MM": [[theme_key, entryCount], ...] },
//     monthlyVolume: { "YYYY-MM": { entries, days, chars } },   // normalisation base for trends
//     winsPerWeek: { "YYYY-MM-DD" (week-ending Sunday): count },
//     winsTotalItems: n,
//     weekdayCounts: [mon, tue, wed, thu, fri, sat, sun],   // entry counts
//     hourCounts: { "0": n, ..., "23": n },                 // by local_time hour
//     gratTotal: n,
//     entryCount: n,
//     dateRange: ["YYYY-MM-DD", "YYYY-MM-DD"],
//     kpi: { totalWords, voiceMinutes, daysCovered, totalDaysInRange, bestStreak }
//   }
//
// Distortions come in two shapes depending on when the bot wrote them: plain strings
// (older rows) and objects {type, quote, reframe} (newer rows). Only `type` is tallied,
// and near-duplicate wordings are folded together (see normaliseDistortion) - otherwise
// 'Долженствование' and 'Долженствование ("надо было")' count as two separate patterns.
//
// Entries carrying `source` other than 'live' are imported archive material and are
// EXCLUDED by default, so KPIs describe the live diary only. Pass --include-archive to
// keep them.
//
// Note: the 7-day rolling average shown on charts is NOT precomputed here -
// it is derived from `series` at render time inside report-template/gen.mjs.
// That keeps stats.json a plain fact table and keeps the smoothing window a
// presentation concern.

import fs from 'node:fs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const entriesPath = args.entries;
const analysesPath = args.analyses;
const metricsPath = args.metrics;
const outPath = args.out || 'stats.json';
const includeArchive = args['include-archive'] === true;

if (!entriesPath || !analysesPath || !metricsPath) {
  console.error('Usage: node compute-stats.mjs --entries <entries.json> --analyses <analyses.json> --metrics <metrics.json> [--out <stats.json>]');
  process.exit(1);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const allEntries = readJson(entriesPath);
const analyses = readJson(analysesPath);
const allMetrics = readJson(metricsPath);

// Keep live diary entries only unless explicitly asked otherwise. Databases without the
// `source` column simply have no archive rows, so the filter is a no-op there.
const entries = includeArchive ? allEntries : allEntries.filter((e) => (e.source ?? 'live') === 'live');
const liveEntryIds = new Set(entries.map((e) => e.id));
const droppedEntries = allEntries.length - entries.length;
const metrics = allMetrics.filter((m) => m.entry_id == null || liveEntryIds.has(m.entry_id));

const METRIC_KEYS = ['mood', 'anxiety', 'stress', 'productivity', 'routine'];

// ---------- entries indexed by id / date ----------
const entryById = new Map(entries.map((e) => [e.id, e]));

// ---------- daily metric series (mean per day per metric) ----------
const byDate = new Map(); // date -> { key: [values] }
for (const m of metrics) {
  if (!byDate.has(m.date)) byDate.set(m.date, {});
  const bucket = byDate.get(m.date);
  for (const key of METRIC_KEYS) {
    const v = m[key];
    if (v === null || v === undefined) continue;
    (bucket[key] ||= []).push(Number(v));
  }
}

const mean = (arr) => (arr && arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

const dates = [...byDate.keys()].sort();
const series = dates.map((date) => {
  const bucket = byDate.get(date);
  const row = { date };
  for (const key of METRIC_KEYS) row[key] = round2(mean(bucket[key]));
  return row;
});

const coverage = {};
for (const key of METRIC_KEYS) coverage[key] = series.filter((r) => r[key] != null).length;

// ---------- monthly averages ----------
const monthOf = (d) => d.slice(0, 7);
const entryDatesByMonth = new Map();
for (const e of entries) {
  const mo = monthOf(e.date);
  (entryDatesByMonth.get(mo) || entryDatesByMonth.set(mo, new Set()).get(mo)).add(e.date);
}
const monthBuckets = new Map();
for (const row of series) {
  const mo = monthOf(row.date);
  if (!monthBuckets.has(mo)) monthBuckets.set(mo, { mood: [], anxiety: [], stress: [], productivity: [], routine: [] });
  const b = monthBuckets.get(mo);
  for (const key of METRIC_KEYS) if (row[key] != null) b[key].push(row[key]);
}
const monthly = [...monthBuckets.keys()].sort().map((mo) => {
  const b = monthBuckets.get(mo);
  const out = { month: mo };
  for (const key of METRIC_KEYS) out[key] = round2(mean(b[key]));
  out.days = entryDatesByMonth.get(mo)?.size ?? 0;
  return out;
});

// ---------- sentiment by month (needs entry date via join) ----------
const sentMonthly = {};
for (const a of analyses) {
  // entryById only holds kept entries, so archive rows fall out here.
  const e = entryById.get(a.entry_id);
  if (!e || !a.sentiment) continue;
  const mo = monthOf(e.date);
  sentMonthly[mo] ||= { positive: 0, neutral: 0, negative: 0, total: 0 };
  if (a.sentiment === 'positive' || a.sentiment === 'neutral' || a.sentiment === 'negative') {
    sentMonthly[mo][a.sentiment]++;
    sentMonthly[mo].total++;
  }
}

// ---------- top themes / emotions / distortions ----------
function safeParseArray(jsonText) {
  if (!jsonText) return [];
  try {
    const v = JSON.parse(jsonText);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
// Distortion entries are either "name" or {type, quote, reframe}; both reduce to a name.
function itemName(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && typeof raw.type === 'string') return raw.type;
  return null;
}

// Fold wording variants of the same pattern into one bucket. Everything after a bracket,
// slash or dash is an example rather than a distinct pattern name.
function normaliseDistortion(name) {
  return name
    .toLowerCase()
    .replace(/[«»"„“”]/g, '')
    .replace(/\s*[([].*$/, '')
    .replace(/\s*[/—–-]\s.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tally(fieldName, normalise = (v) => v.trim().toLowerCase(), rows = analyses) {
  const counts = new Map();
  for (const a of rows) {
    for (const raw of safeParseArray(a[fieldName])) {
      const name = itemName(raw);
      if (!name) continue;
      const key = normalise(name);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// Analyses belonging to filtered-out entries must not leak into the tallies.
const liveAnalyses = analyses.filter((a) => entryById.has(a.entry_id));

const topThemes = tally('topics_json', undefined, liveAnalyses);
const topEmotions = tally('emotions_json', undefined, liveAnalyses);
const topDistortions = tally('distortions_json', normaliseDistortion, liveAnalyses);

// ---------- distortions and orbits over time ----------
const analysesByMonth = new Map();
for (const a of liveAnalyses) {
  const e = entryById.get(a.entry_id);
  if (!e) continue;
  const mo = monthOf(e.date);
  (analysesByMonth.get(mo) || analysesByMonth.set(mo, []).get(mo)).push(a);
}
const distortionsByMonth = {};
const orbitsByMonth = {};
for (const [mo, rows] of [...analysesByMonth.entries()].sort()) {
  distortionsByMonth[mo] = tally('distortions_json', normaliseDistortion, rows);
  const monthOrbits = tally('orbit_themes_json', undefined, rows);
  if (monthOrbits.length) orbitsByMonth[mo] = monthOrbits;
}

// Orbits are counted in UNIQUE DAYS, not entries: a theme mentioned five times on one
// day is one day of that theme, and days are what makes "it keeps coming back" legible.
const orbitDays = new Map();
for (const a of liveAnalyses) {
  const e = entryById.get(a.entry_id);
  if (!e) continue;
  for (const raw of safeParseArray(a.orbit_themes_json)) {
    const name = itemName(raw);
    if (!name) continue;
    const key = name.trim();
    if (!key) continue;
    (orbitDays.get(key) || orbitDays.set(key, new Set()).get(key)).add(e.date);
  }
}
const orbits = [...orbitDays.entries()]
  .map(([theme, days]) => [theme, days.size])
  .sort((a, b) => b[1] - a[1]);

// ---------- per-month volume (normalisation base for the trend charts) ----------
const monthlyVolume = {};
for (const e of entries) {
  const mo = monthOf(e.date);
  const bucket = (monthlyVolume[mo] ||= { entries: 0, days: new Set(), chars: 0 });
  bucket.entries++;
  bucket.days.add(e.date);
  bucket.chars += (e.text || '').length;
}
for (const mo of Object.keys(monthlyVolume)) {
  monthlyVolume[mo] = {
    entries: monthlyVolume[mo].entries,
    days: monthlyVolume[mo].days.size,
    chars: monthlyVolume[mo].chars,
  };
}

// ---------- wins per week (week key = Sunday, end of ISO week) ----------
function isoWeekSunday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 6);
  return d.toISOString().slice(0, 10);
}
const winsPerWeek = {};
let winsTotalItems = 0;
for (const a of liveAnalyses) {
  const e = entryById.get(a.entry_id);
  if (!e) continue;
  const wins = safeParseArray(a.wins_json);
  if (!wins.length) continue;
  const wk = isoWeekSunday(e.date);
  winsPerWeek[wk] = (winsPerWeek[wk] || 0) + wins.length;
  winsTotalItems += wins.length;
}

// ---------- weekday / hour distribution ----------
const weekdayCounts = [0, 0, 0, 0, 0, 0, 0]; // Mon..Sun
const hourCounts = {};
for (const e of entries) {
  const d = new Date(`${e.date}T00:00:00Z`);
  const dayNum = (d.getUTCDay() + 6) % 7;
  weekdayCounts[dayNum]++;
  if (e.local_time) {
    const hourMatch = /^(\d{1,2}):/.exec(e.local_time);
    if (hourMatch) {
      const h = String(parseInt(hourMatch[1], 10));
      hourCounts[h] = (hourCounts[h] || 0) + 1;
    }
  }
}

// ---------- gratitude ----------
const gratTotal = liveAnalyses.reduce((sum, a) => sum + (a.gratitude_count || 0), 0);

// ---------- KPIs ----------
const entryDates = [...new Set(entries.map((e) => e.date))].sort();
const dateRange = entries.length ? [entryDates[0], entryDates[entryDates.length - 1]] : [null, null];

const totalWords = entries.reduce((sum, e) => sum + (e.text ? e.text.trim().split(/\s+/).filter(Boolean).length : 0), 0);
const VOICE_TYPES = new Set(['voice', 'forwarded_voice']);
const voiceMinutes = round2(
  entries.reduce((sum, e) => sum + (VOICE_TYPES.has(e.type) && e.duration_seconds ? e.duration_seconds : 0), 0) / 60
);

const totalDaysInRange = dateRange[0]
  ? Math.round((new Date(dateRange[1]) - new Date(dateRange[0])) / 86400000) + 1
  : 0;

let bestStreak = 0;
let cur = 0;
let prevDate = null;
for (const d of entryDates) {
  if (prevDate && (new Date(d) - new Date(prevDate)) / 86400000 === 1) {
    cur++;
  } else {
    cur = 1;
  }
  bestStreak = Math.max(bestStreak, cur);
  prevDate = d;
}

const stats = {
  series,
  coverage,
  monthly,
  sentMonthly,
  topThemes,
  topEmotions,
  topDistortions,
  distortionsByMonth,
  orbits,
  orbitsByMonth,
  monthlyVolume,
  winsPerWeek,
  winsTotalItems,
  weekdayCounts,
  hourCounts,
  gratTotal,
  entryCount: entries.length,
  dateRange,
  kpi: {
    totalWords,
    voiceMinutes,
    daysCovered: entryDates.length,
    totalDaysInRange,
    bestStreak,
  },
};

fs.writeFileSync(outPath, JSON.stringify(stats, null, 1));
console.log(`Wrote ${outPath} (${entries.length} entries, ${dates.length} metric-days, range ${dateRange[0]}..${dateRange[1]}).`);
if (droppedEntries > 0) {
  console.log(`  excluded ${droppedEntries} non-live (archive) entries; pass --include-archive to keep them.`);
}
