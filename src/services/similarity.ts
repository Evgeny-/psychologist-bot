import OpenAI from 'openai';
import { config } from '../config.js';
import { queries } from '../db/index.js';
import { RECENT_DAILY_MEMORY_DAYS } from '../prompts/memory.js';
import { shiftLocalDate, todayLocal } from '../utils/date.js';
import { logWarn } from '../utils/logger.js';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
const MAX_EMBED_CHARS = 8000;
const SNIPPET_CHARS = 200;

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!config.keys.openai) return null;
  if (!client) client = new OpenAI({ apiKey: config.keys.openai });
  return client;
}

/** Compute an embedding vector for arbitrary text. Null without a key / on empty input. */
export async function computeEntryVector(text: string): Promise<Float32Array | null> {
  const openai = getClient();
  if (!openai) return null;
  const input = text.replace(/\s+/g, ' ').trim().slice(0, MAX_EMBED_CHARS);
  if (!input) return null;
  const response = await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
  const vector = response.data[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) return null;
  return Float32Array.from(vector);
}

/** Persist a precomputed vector for an entry. */
export function storeEntryVector(entryId: number, vector: Float32Array): void {
  queries.upsertEntryEmbedding({
    entry_id: entryId,
    model: EMBEDDING_MODEL,
    vector: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
  });
}

function bufferToFloat32(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Compute and store the embedding for an entry. No-op without an OpenAI key. */
export async function embedEntryText(entryId: number, text: string): Promise<void> {
  const vector = await computeEntryVector(text);
  if (!vector) return;
  storeEntryVector(entryId, vector);
}

interface SimilarOptions {
  excludeEntryId?: number;
  topK?: number;
  minSimilarity?: number;
  /** Reuse a precomputed query vector instead of paying for a second embedding call. */
  queryVec?: Float32Array;
}

/**
 * Find past episodes semantically similar to `text`. Returns a formatted context block
 * or null if nothing relevant / embeddings unavailable. Fully fail-soft.
 */
export async function findSimilarEpisodes(text: string, opts: SimilarOptions = {}): Promise<string | null> {
  const { excludeEntryId, topK = 4, minSimilarity = 0.35 } = opts;
  try {
    if (!config.keys.openai && !opts.queryVec) return null;

    // Cheap checks first: don't pay for an embedding call when there is nothing to compare against.
    // Vectors from a different embedding model are incomparable — filter them out explicitly.
    const embeddings = queries.getAllEntryEmbeddings().filter((row) => row.model === EMBEDDING_MODEL);
    if (embeddings.length === 0) return null;

    const queryVec = opts.queryVec ?? await computeEntryVector(text);
    if (!queryVec) return null;

    // Exclude entries from the same date as the current entry (usually "today").
    let excludeDate: string | null = null;
    if (excludeEntryId !== undefined) {
      const self = queries.getEntrySnippetsByIds([excludeEntryId]);
      excludeDate = self[0]?.date ?? null;
    }
    // The last RECENT_DAILY_MEMORY_DAYS are already present in the system prompt as
    // daily summaries — retrieving them again would only duplicate context. This block
    // exists to resurface OLDER, otherwise-forgotten episodes.
    const recentCutoff = shiftLocalDate(excludeDate ?? todayLocal(), -RECENT_DAILY_MEMORY_DAYS);

    const scored: Array<{ entryId: number; sim: number }> = [];
    for (const row of embeddings) {
      if (excludeEntryId !== undefined && row.entry_id === excludeEntryId) continue;
      const sim = cosine(queryVec, bufferToFloat32(row.vector));
      if (sim >= minSimilarity) scored.push({ entryId: row.entry_id, sim });
    }
    if (scored.length === 0) return null;

    scored.sort((a, b) => b.sim - a.sim);
    // Extra headroom: the date filters below (same-day, recent window, per-date dedup)
    // can discard a large share of the top-scored candidates.
    const candidates = scored.slice(0, topK + 15);
    const snippets = queries.getEntrySnippetsByIds(candidates.map((c) => c.entryId));
    const snippetById = new Map(snippets.map((s) => [s.id, s]));

    const picked: Array<{ date: string; text: string }> = [];
    for (const c of candidates) {
      if (picked.length >= topK) break;
      const snip = snippetById.get(c.entryId);
      if (!snip) continue;
      if (excludeDate && snip.date === excludeDate) continue;
      if (snip.date >= recentCutoff) continue;
      if (picked.some((p) => p.date === snip.date)) continue;
      picked.push({ date: snip.date, text: (snip.text ?? '').replace(/\s+/g, ' ').trim() });
    }
    if (picked.length === 0) return null;

    const summaries = queries.getDailyMemorySummariesByDates(picked.map((p) => p.date));

    const header = config.language === 'ru'
      ? '--- ПОХОЖИЕ ЭПИЗОДЫ ИЗ ПРОШЛОГО (используй только если реально релевантно; помогает вспомнить, что сработало) ---'
      : '--- SIMILAR EPISODES FROM THE PAST (use only if genuinely relevant; helps recall what worked) ---';

    const lines = picked.map((p) => {
      const summary = summaries.get(p.date);
      const body = summary
        ? summary.replace(/\s+/g, ' ').trim()
        : p.text.slice(0, SNIPPET_CHARS);
      return `[${p.date}] ${body}`;
    });

    return `${header}\n${lines.join('\n')}`;
  } catch (err) {
    logWarn('similarity.find_failed', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
