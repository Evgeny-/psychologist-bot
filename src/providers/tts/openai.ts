import OpenAI from 'openai';
import type { TTSProvider, TTSResult } from './index.js';
import { ApiBalanceError } from './elevenlabs.js';
import { withRetry } from '../../utils/retry.js';

const OPENAI_TTS_MAX_INPUT = 4096;

// OpenAI's legacy TTS models are billed per 1M input characters.
const OPENAI_TTS_PRICING_PER_1M_CHARS: Record<string, number> = {
  'tts-1': 15,
  'tts-1-hd': 30,
};

export class OpenAITTS implements TTSProvider {
  private client: OpenAI;
  readonly providerName = 'openai';
  readonly maxInputLength = OPENAI_TTS_MAX_INPUT;

  constructor(
    apiKey: string,
    private model: string,
    private voice: string,
  ) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for OpenAI TTS');
    this.client = new OpenAI({ apiKey });
  }

  get modelName(): string {
    return this.model;
  }

  async synthesize(text: string): Promise<TTSResult> {
    try {
      const response = await withRetry(() => this.client.audio.speech.create({
        model: this.model,
        voice: this.voice,
        input: text,
        response_format: 'mp3',
      }));

      const arrayBuffer = await response.arrayBuffer();
      const pricingPer1MChars = OPENAI_TTS_PRICING_PER_1M_CHARS[this.model];

      return {
        audioBuffer: Buffer.from(arrayBuffer),
        mimeType: 'audio/mpeg',
        extension: 'mp3',
        usage: {
          charCount: text.length,
          costUsd: pricingPer1MChars !== undefined
            ? (text.length * pricingPer1MChars) / 1_000_000
            : undefined,
        },
      };
    } catch (err: unknown) {
      if (err instanceof OpenAI.APIError) {
        if (err.status === 401 || err.status === 429 || err.message?.includes('quota') || err.message?.includes('billing')) {
          throw new ApiBalanceError(`OpenAI TTS: ${err.status} ${err.message}`);
        }
      }
      throw err;
    }
  }
}
