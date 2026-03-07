/** Retry a function on transient errors (5xx, network, timeout). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 1, delayMs = 2000 } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries && isTransient(err)) {
        console.warn(`Transient error (attempt ${attempt + 1}/${retries + 1}), retrying in ${delayMs}ms...`, err instanceof Error ? err.message : err);
        await sleep(delayMs * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function isTransient(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // Network errors
    if (msg.includes('fetch failed') || msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up')) {
      return true;
    }
  }
  // API errors with 5xx or 429 status
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: number }).status;
    if (status >= 500 || status === 429) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
