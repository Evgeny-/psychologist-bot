import OpenAI from 'openai';
import type { LLMProvider, LLMResult, ChatMessage } from './index.js';
import { ApiBalanceError } from './claude.js';
import { withRetry } from '../../utils/retry.js';

// Pricing per million tokens
const OPENAI_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-5.4': { input: 3.0, output: 15.0 },
  'gpt-5.4-pro': { input: 15.0, output: 75.0 },
  'gpt-5.2': { input: 2.5, output: 10.0 },
  'gpt-5.2-pro': { input: 15.0, output: 75.0 },
  'gpt-5.1': { input: 2.5, output: 10.0 },
  'gpt-5': { input: 2.5, output: 10.0 },
  'gpt-5-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};
const DEFAULT_OPENAI_PRICING = { input: 3.0, output: 15.0 };

export class OpenAILLM implements LLMProvider {
  private client: OpenAI;
  readonly providerName = 'openai';

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  get modelName(): string {
    return this.model;
  }

  async analyze(userPrompt: string, systemPrompt: string): Promise<LLMResult> {
    return this.chat([{ role: 'user', content: userPrompt }], systemPrompt);
  }

  async chat(messages: ChatMessage[], systemPrompt: string): Promise<LLMResult> {
    try {
      const response = await withRetry(() => this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        max_completion_tokens: 4096,
      }));

      const text = response.choices[0]?.message?.content ?? '';
      const inputTokens = response.usage?.prompt_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? 0;
      const pricing = OPENAI_PRICING[this.model] ?? DEFAULT_OPENAI_PRICING;
      const costUsd = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

      return { text, usage: { inputTokens, outputTokens, costUsd } };
    } catch (err: unknown) {
      if (err instanceof OpenAI.APIError) {
        if (err.status === 401 || err.status === 429 || err.message?.includes('quota') || err.message?.includes('billing')) {
          throw new ApiBalanceError(`OpenAI LLM: ${err.status} ${err.message}`);
        }
      }
      throw err;
    }
  }
}
