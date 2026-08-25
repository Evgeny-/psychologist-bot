/**
 * Prompt-eval harness for the daily analysis.
 *
 * Rebuilds the REAL prompt (memory blocks + contract + label review + patterns + already-asked
 * questions + similar episodes + yesterday/earlier context) for existing entries out of a DB dump, runs it against
 * OpenAI with a chosen system-prompt variant / model / reasoning effort, and saves
 * side-by-side results for comparison.
 *
 * Usage:
 *   DB_PATH=/path/to/dump.db OPENAI_API_KEY=sk-... npx tsx scripts/eval-analysis.ts \
 *     --entries 165,174,180 \
 *     [--system-file prompts/variants/daily-v2.txt]  # overrides the BASE daily prompt
 *     [--label v2]                                   # name for this variant in outputs
 *     [--model gpt-5.5] [--effort low|medium|high] [--verbosity low|medium]
 *     [--out /path/to/results-dir]
 *     [--dry]                                        # build prompts, no API calls
 *
 * The dump is opened read-write by better-sqlite3 but the harness performs no writes.
 * Never point DB_PATH at the production database.
 */
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

if (!process.env.DB_PATH) {
  console.error('Set DB_PATH to a DB dump (never production).');
  process.exit(1);
}

const entryIds = (arg('entries') || '').split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);
if (entryIds.length === 0) {
  console.error('Pass --entries 165,174,...');
  process.exit(1);
}

const model = arg('model') || 'gpt-5.5';
const effort = (arg('effort') || 'low') as 'minimal' | 'low' | 'medium' | 'high';
const verbosity = (arg('verbosity') || 'medium') as 'low' | 'medium' | 'high';
const label = arg('label') || (arg('system-file') ? path.basename(arg('system-file')!, path.extname(arg('system-file')!)) : 'baseline');
const outDir = arg('out') || path.join(process.cwd(), 'eval-results');
const dry = hasFlag('dry');

// Import AFTER env is in place (db path, dotenv in config).
const { queries } = await import('../src/db/index.js');
const { buildUserPromptWithContext } = await import('../src/services/analysis.js');
const { buildSystemPromptWithUserMemory } = await import('../src/services/memory-context.js');
const { getDailySystemPrompt } = await import('../src/prompts/daily.js');
const { computeEntryVector } = await import('../src/services/similarity.js');
const { config } = await import('../src/config.js');

const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-5.6-sol': { input: 5, output: 30 },
  'gpt-5.6-terra': { input: 2.5, output: 15 },
  'gpt-5.6-luna': { input: 1, output: 6 },
  'gpt-5.5': { input: 5, output: 30 },
};

const basePrompt = arg('system-file')
  ? fs.readFileSync(arg('system-file')!, 'utf8')
  : getDailySystemPrompt();

fs.mkdirSync(outDir, { recursive: true });
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
if (!openai && !dry) {
  console.error('OPENAI_API_KEY missing (or use --dry).');
  process.exit(1);
}

interface RunRecord {
  entryId: number;
  label: string;
  model: string;
  effort: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  elapsedMs?: number;
  outFile: string;
}
const index: RunRecord[] = [];

for (const entryId of entryIds) {
  const row = queries.getEntryById(entryId);
  if (!row) {
    console.error(`entry ${entryId}: not found in dump, skipping`);
    continue;
  }
  const text: string = row.transcript || row.raw_text || '';
  const date: string = row.date;

  const vector = openai ? await computeEntryVector(text).catch(() => null) : null;
  const userPrompt = await buildUserPromptWithContext(text, date, entryId, vector);
  const systemPrompt = buildSystemPromptWithUserMemory(basePrompt, date, { includeReferenceDate: false });

  const slug = `${entryId}-${label}-${model}-${effort}`;
  const outFile = path.join(outDir, `${slug}.md`);

  if (dry) {
    fs.writeFileSync(outFile, [
      `# entry ${entryId} · ${date} · DRY (no API call)`,
      `## SYSTEM (${systemPrompt.length} chars)`, '```', systemPrompt, '```',
      `## USER (${userPrompt.length} chars)`, '```', userPrompt, '```',
    ].join('\n'));
    console.log(`dry  ${slug}  system=${systemPrompt.length}c user=${userPrompt.length}c`);
    index.push({ entryId, label, model, effort, outFile });
    continue;
  }

  const started = Date.now();
  const resp = await openai!.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_completion_tokens: 12000,
    reasoning_effort: effort,
    verbosity,
  } as never);
  const elapsedMs = Date.now() - started;

  const message = (resp as any).choices?.[0]?.message?.content ?? '';
  const usage = (resp as any).usage ?? {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  const p = PRICING[model] ?? { input: 5, output: 30 };
  const costUsd = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;

  fs.writeFileSync(outFile, [
    `# entry ${entryId} · ${date} · ${label} · ${model} · effort=${effort}`,
    `tokens: ${inputTokens} in / ${outputTokens} out (reasoning ${reasoningTokens ?? '—'}) · $${costUsd.toFixed(4)} · ${(elapsedMs / 1000).toFixed(1)}s`,
    '',
    '## RESPONSE', '', message, '',
    '<details><summary>USER PROMPT</summary>', '', '```', userPrompt, '```', '</details>',
    '<details><summary>SYSTEM PROMPT</summary>', '', '```', systemPrompt, '```', '</details>',
  ].join('\n'));

  console.log(`done ${slug}  ${inputTokens}in/${outputTokens}out (r${reasoningTokens ?? '—'}) $${costUsd.toFixed(4)} ${(elapsedMs / 1000).toFixed(1)}s`);
  index.push({ entryId, label, model, effort, inputTokens, outputTokens, reasoningTokens, costUsd, elapsedMs, outFile });

  await new Promise((r) => setTimeout(r, 500)); // be gentle with rate limits
}

fs.appendFileSync(path.join(outDir, 'index.jsonl'), index.map((r) => JSON.stringify(r)).join('\n') + '\n');
const spent = index.reduce((s, r) => s + (r.costUsd ?? 0), 0);
console.log(`\n${index.length} runs, total $${spent.toFixed(4)} → ${outDir}`);
process.exit(0);
