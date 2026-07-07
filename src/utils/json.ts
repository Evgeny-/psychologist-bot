const JSON_FENCE = /```json\s*([\s\S]*?)\s*```/;

/**
 * Parse a JSON payload from an LLM response: the content of the first ```json fence,
 * or the whole text when no fence is present. Null when nothing parseable is found.
 */
export function parseJsonResponse<T>(text: string): T | null {
  const match = text.match(JSON_FENCE);
  const jsonText = match ? match[1] : text;
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    return null;
  }
}

/** Remove the first ```json fence block, returning the surrounding prose (trimmed). */
export function stripJsonBlock(text: string): string {
  return text.replace(JSON_FENCE, '').trim();
}
