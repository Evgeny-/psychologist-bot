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
//     topDistortions: [[name, count], ...],  // from analyses.distortions_json
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

if (!entriesPath || !analysesPath || !metricsPath) {
  console.error('Usage: node compute-stats.mjs --entries <entries.json> --analyses <analyses.json> --metrics <metrics.json> [--out <stats.json>]');
  process.exit(1);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const entries = readJson(entriesPath);
const analyses = readJson(analysesPath);
const metrics = readJson(metricsPath);

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
function tally(fieldName) {
  const counts = new Map();
  for (const a of analyses) {
    for (const raw of safeParseArray(a[fieldName])) {
      if (typeof raw !== 'string') continue;
      const key = raw.trim().toLowerCase();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
const topThemes = tally('topics_json');
const topEmotions = tally('emotions_json');
const topDistortions = tally('distortions_json');

// ---------- wins per week (week key = Sunday, end of ISO week) ----------
function isoWeekSunday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 6);
  return d.toISOString().slice(0, 10);
}
const winsPerWeek = {};
let winsTotalItems = 0;
for (const a of analyses) {
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
const gratTotal = analyses.reduce((sum, a) => sum + (a.gratitude_count || 0), 0);

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
