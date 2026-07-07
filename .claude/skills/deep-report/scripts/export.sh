#!/usr/bin/env bash
# Export the relevant CBT-bot tables from a local SQLite snapshot to JSON files.
#
# Run this AFTER the snapshot has already been copied to a local path with
# `better-sqlite3`'s .backup() (see SKILL.md step 1) - a plain `cp`/`scp` of a
# WAL-mode database file can miss data that is still sitting in the -wal file.
#
# Requires the `sqlite3` CLI locally (it does not need to exist on the server).
#
# Usage:
#   ./export.sh <path-to-db> [output-dir]
#
# Output files (all JSON arrays, one row per array element):
#   <output-dir>/entries.json       id, date, local_time, type, text, duration_seconds
#   <output-dir>/analyses.json      entry_id, sentiment, emotions_json, triggers_json,
#                                    wins_json, topics_json, distortions_json, gratitude_count
#   <output-dir>/metrics.json       entry_id, date, mood, anxiety, stress, productivity, routine
#   <output-dir>/daily_memory.json  full table dump
#   <output-dir>/memory.json        full table dump

set -euo pipefail

DB_PATH="${1:?Usage: export.sh <path-to-db> [output-dir]}"
OUT_DIR="${2:-export}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "error: sqlite3 CLI not found locally. Install it (e.g. 'brew install sqlite') and retry." >&2
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "error: db file not found: $DB_PATH" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "Exporting from $DB_PATH into $OUT_DIR/ ..."

sqlite3 -json "$DB_PATH" "
  SELECT id, date, local_time, type,
         COALESCE(transcript, raw_text) AS text,
         duration_seconds
  FROM entries
  ORDER BY date, id;
" > "$OUT_DIR/entries.json"

sqlite3 -json "$DB_PATH" "
  SELECT entry_id, sentiment, emotions_json, triggers_json,
         wins_json, topics_json, distortions_json, gratitude_count
  FROM analyses
  ORDER BY entry_id;
" > "$OUT_DIR/analyses.json"

sqlite3 -json "$DB_PATH" "
  SELECT entry_id, date, mood, anxiety, stress, productivity, routine
  FROM metrics
  ORDER BY date, entry_id;
" > "$OUT_DIR/metrics.json"

sqlite3 -json "$DB_PATH" "
  SELECT date, summary, source_entry_id
  FROM daily_memory
  ORDER BY date;
" > "$OUT_DIR/daily_memory.json"

sqlite3 -json "$DB_PATH" "
  SELECT content, updated_at
  FROM memory;
" > "$OUT_DIR/memory.json"

echo "Done. Row counts:"
for f in entries analyses metrics daily_memory memory; do
  n=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OUT_DIR/$f.json','utf8')).length)" 2>/dev/null || echo '?')
  printf '  %-14s %s\n' "$f.json" "$n"
done

echo
echo "Reminder: entries.json / analyses.json / daily_memory.json / memory.json contain"
echo "personal diary content. Keep the output directory OUTSIDE the repo (scratchpad),"
echo "never commit it, and do not paste raw entries into this skill or its docs."
