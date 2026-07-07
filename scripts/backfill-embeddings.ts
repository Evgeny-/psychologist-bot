/**
 * Backfill entry embeddings for semantic similarity lookups.
 *
 * Idempotent: only processes entries that don't already have an embedding.
 * Run with: npx tsx scripts/backfill-embeddings.ts
 */
import { queries } from '../src/db/index.js';
import { embedEntryText } from '../src/services/similarity.js';
import { config } from '../src/config.js';

const BATCH_SIZE = 20;
const PAUSE_MS = 1000;

async function main(): Promise<void> {
  if (!config.keys.openai) {
    console.error('OPENAI_API_KEY is not set — cannot backfill embeddings.');
    process.exit(1);
  }

  let total = 0;
  const attempted = new Set<number>();

  for (;;) {
    const batch = queries.getEntriesWithoutEmbeddings(BATCH_SIZE);
    if (batch.length === 0) break;

    // Guard against an infinite loop if some entries can never be embedded.
    const fresh = batch.filter((e) => !attempted.has(e.id));
    if (fresh.length === 0) {
      console.warn(`Stopping: ${batch.length} entries remain without embeddings but could not be processed.`);
      break;
    }

    for (const entry of fresh) {
      attempted.add(entry.id);
      try {
        await embedEntryText(entry.id, entry.text);
        total++;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`Failed to embed entry ${entry.id}: ${reason}`);
      }
    }

    console.log(`Embedded ${total} entries so far (last id ${fresh[fresh.length - 1].id})...`);
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }

  console.log(`Done. Embedded ${total} entries.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
