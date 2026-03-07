import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMResult, ChatMessage } from './index.js';

// Pricing per million tokens
const CLAUDE_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
};
const DEFAULT_CLAUDE_PRICING = { input: 3.0, output: 15.0 };

export class ApiBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiBalanceError';
  }
}

export class ClaudeLLM implements LLMProvider {
  private client: Anthropic;
  readonly providerName = 'claude';

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  get modelName(): string {
    return this.model;
  }

  async analyze(userPrompt: string, systemPrompt: string): Promise<LLMResult> {
    return this.chat([{ role: 'user', content: userPrompt }], systemPrompt);
  }

  async chat(messages: ChatMessage[], systemPrompt: string): Promise<LLMResult> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
      });

      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const pricing = CLAUDE_PRICING[this.model] ?? DEFAULT_CLAUDE_PRICING;
      const costUsd = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

      return { text, usage: { inputTokens, outputTokens, costUsd } };
    } catch (err: unknown) {
      if (err instanceof Anthropic.APIError) {
        if (err.status === 401 || err.status === 429 || err.message?.includes('credit') || err.message?.includes('billing')) {
          throw new ApiBalanceError(`Claude: ${err.status} ${err.message}`);
        }
      }
      throw err;
    }
  }
}
