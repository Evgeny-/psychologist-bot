import OpenAI from 'openai';
import type { ASRProvider } from './index.js';
import { ApiBalanceError } from './elevenlabs.js';

const OPENAI_ASR_PRICING: Record<string, number> = {
  'gpt-4o-transcribe': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
  'whisper-1': 0.006,
};

export class OpenAIASR implements ASRProvider {
  private client: OpenAI;
  readonly costPerMinute: number;

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.costPerMinute = OPENAI_ASR_PRICING[model] ?? 0.006;
    this.client = new OpenAI({ apiKey });
  }

  async transcribe(audioBuffer: Buffer, lang: string): Promise<string> {
    try {
      const file = new File([new Uint8Array(audioBuffer)], 'audio.ogg', { type: 'audio/ogg' });

      const response = await this.client.audio.transcriptions.create({
        file,
        model: this.model,
        language: lang,
      });

      // The response shape varies by model - handle both
      if (typeof response === 'string') return response;
      return (response as { text: string }).text;
    } catch (err: unknown) {
      if (err instanceof OpenAI.APIError) {
        if (err.status === 401 || err.status === 429 || err.message?.includes('quota') || err.message?.includes('billing')) {
          throw new ApiBalanceError(`OpenAI ASR: ${err.status} ${err.message}`);
        }
      }
      throw err;
    }
  }
}
