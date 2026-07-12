/**
 * Backfill orbit_themes_json on existing analyses by classifying entry transcripts
 * against the closed orbit taxonomy (src/prompts/orbits.ts).
 *
 * Usage:
 *   DB_PATH=/path/to/db OPENAI_API_KEY=sk-... npx tsx scripts/backfill-orbit-themes.ts \
 *     [--model gpt-5.6-sol] [--limit N] [--force]
 *
 * Only fills rows where orbit_themes_json IS NULL (idempotent); --force re-tags everything.
 * Tags the first-saved analysis per entry — the same row every reader dedups to.
 */
import OpenAI from 'openai';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

if (!process.env.DB_PATH) {
  console.error('Set DB_PATH explicitly (never run against a DB you did not intend).');
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY missing.');
  process.exit(1);
}

const model = arg('model') || 'gpt-5.6-sol';
const limit = parseInt(arg('limit') || '0', 10);
const force = hasFlag('force');

const { db } = await import('../src/db/index.js');
const { ORBIT_THEMES, isOrbitThemeKey, renderOrbitTaxonomy } = await import('../src/prompts/orbits.js');

const rows = db.prepare(`
  SELECT a.id as analysis_id, e.id as entry_id, e.date, COALESCE(e.transcript, e.raw_text) as text
  FROM analyses a
  JOIN entries e ON e.id = a.entry_id
  WHERE a.id IN (SELECT MIN(id) FROM analyses GROUP BY entry_id)
    ${force ? '' : 'AND a.orbit_themes_json IS NULL'}
  ORDER BY e.date ASC
  ${limit > 0 ? `LIMIT ${limit}` : ''}
`).all() as Array<{ analysis_id: number; entry_id: number; date: string; text: string | null }>;

console.log(`rows to tag: ${rows.length} (model=${model})`);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const update = db.prepare('UPDATE analyses SET orbit_themes_json = ? WHERE id = ?');

const system = `Ты — классификатор записей личного дневника. Верни JSON-объект {"orbit_themes": ["ключ1", ...]}.
Выбирай ключи ТОЛЬКО из закрытого списка ниже — темы, которые запись затрагивает СОДЕРЖАТЕЛЬНО (эмоционально или сюжетно, не мимоходом одним словом). 0–3 ключа; если ничего не подходит — пустой массив. Никаких ключей вне списка.
${renderOrbitTaxonomy('ru')}`;

let done = 0;
let tagged = 0;
for (const row of rows) {
  const text = (row.text || '').slice(0, 6000);
  if (!text.trim()) {
    update.run('[]', row.analysis_id);
    done++;
    continue;
  }
  try {
    const resp = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
      max_completion_tokens: 2000,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
    } as never);
    const raw = (resp as never as { choices: Array<{ message: { content: string } }> }).choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as { orbit_themes?: unknown };
    const themes = Array.isArray(parsed.orbit_themes)
      ? parsed.orbit_themes.filter(isOrbitThemeKey).slice(0, 3)
      : [];
    update.run(JSON.stringify(themes), row.analysis_id);
    if (themes.length > 0) tagged++;
    done++;
    if (done % 20 === 0) console.log(`[${done}/${rows.length}] ...`);
  } catch (err) {
    console.error(`entry ${row.entry_id} (${row.date}) failed: ${err instanceof Error ? err.message : err}`);
  }
  await new Promise((r) => setTimeout(r, 250));
}

console.log(`done: ${done}/${rows.length}, with themes: ${tagged}`);
const counts = db.prepare(`
  SELECT je.value theme, COUNT(DISTINCT e.date) days
  FROM analyses a JOIN entries e ON e.id = a.entry_id, json_each(a.orbit_themes_json) je
  WHERE a.id IN (SELECT MIN(id) FROM analyses GROUP BY entry_id)
  GROUP BY je.value ORDER BY days DESC
`).all() as Array<{ theme: string; days: number }>;
console.log('theme days:', counts.map((c) => `${c.theme}:${c.days}`).join('  '));
console.log('known keys:', ORBIT_THEMES.map((t) => t.key).join(', '));
process.exit(0);
