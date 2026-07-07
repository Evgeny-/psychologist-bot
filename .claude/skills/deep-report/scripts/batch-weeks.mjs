#!/usr/bin/env node
// Group diary entries into ISO-week batches so that a separate subagent can
// summarize each week independently and in parallel.
//
// Joins entries.json with analyses.json (by entry_id) so each entry in a
// batch carries its own text plus whatever the bot's own analysis already
// extracted (sentiment/emotions/topics/distortions/wins). Weeks are ISO
// weeks (Monday-Sunday), numbered sequentially in chronological order
// starting at week-01 - NOT by calendar week-of-year - so file names stay
// stable and ordered regardless of which month/year the data starts in.
//
// Usage:
//   node batch-weeks.mjs --entries export/entries.json \
//                         --analyses export/analyses.json \
//                         --out batches
//
// --analyses is optional; omit it to batch raw entries only.
//
// Output:
//   <out>/week-01.json, week-02.json, ...   one file per ISO week
//   <out>/index.json                        [{ file, week, from, to, count, chars }, ...]

import fs from 'node:fs';
import path from 'node:path';

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
const outDir = args.out || 'batches';

if (!entriesPath) {
  console.error('Usage: node batch-weeks.mjs --entries <entries.json> [--analyses <analyses.json>] [--out <dir>]');
  process.exit(1);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function toDateUTC(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`);
}

// Monday of the ISO week containing `dateStr`.
function isoWeekMonday(dateStr) {
  const d = toDateUTC(dateStr);
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum);
  return d;
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

const entries = readJson(entriesPath);
const analysesByEntry = new Map();
if (analysesPath) {
  for (const a of readJson(analysesPath)) {
    analysesByEntry.set(a.entry_id, a);
  }
}

function safeParseArray(jsonText) {
  if (!jsonText) return [];
  try {
    const v = JSON.parse(jsonText);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Merge entry + its analysis (if any) into one flat record for the subagent.
const enriched = entries.map((e) => {
  const a = analysesByEntry.get(e.id);
  return {
    id: e.id,
    date: e.date,
    local_time: e.local_time || null,
    type: e.type,
    text: e.text || '',
    duration_seconds: e.duration_seconds ?? null,
    sentiment: a?.sentiment ?? null,
    emotions: safeParseArray(a?.emotions_json),
    triggers: safeParseArray(a?.triggers_json),
    wins: safeParseArray(a?.wins_json),
    topics: safeParseArray(a?.topics_json),
    distortions: safeParseArray(a?.distortions_json),
    gratitude_count: a?.gratitude_count ?? 0,
  };
});

// Group by ISO week (keyed by the Monday date, sorted chronologically).
const weeks = new Map(); // mondayIso -> entries[]
for (const rec of enriched) {
  const monday = fmt(isoWeekMonday(rec.date));
  if (!weeks.has(monday)) weeks.set(monday, []);
  weeks.get(monday).push(rec);
}

const sortedMondays = [...weeks.keys()].sort();

fs.mkdirSync(outDir, { recursive: true });

const index = [];
sortedMondays.forEach((monday, i) => {
  const recs = weeks.get(monday).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const num = String(i + 1).padStart(2, '0');
  const file = `week-${num}.json`;
  const dates = recs.map((r) => r.date);
  const from = dates.reduce((min, d) => (d < min ? d : min), dates[0]);
  const to = dates.reduce((max, d) => (d > max ? d : max), dates[0]);
  const chars = recs.reduce((sum, r) => sum + (r.text ? r.text.length : 0), 0);

  const payload = {
    week: num,
    isoWeekStart: monday,
    from,
    to,
    entries: recs,
  };
  fs.writeFileSync(path.join(outDir, file), JSON.stringify(payload, null, 1));

  index.push({ file: `${path.basename(outDir)}/${file}`, week: num, from, to, count: recs.length, chars });
});

fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1));

console.log(`Wrote ${index.length} week batches to ${outDir}/ (index.json included).`);
console.log('Reminder: batch files contain raw diary text - keep them out of the repo.');
