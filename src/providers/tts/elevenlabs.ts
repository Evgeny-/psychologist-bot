import type { TTSProvider, TTSResult } from './index.js';
import { withRetry } from '../../utils/retry.js';

const ELEVENLABS_TTS_MAX_INPUT = 40_000;
const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';

// ElevenLabs bills some low-latency models at 1 credit / 2 chars, others at 1 credit / char.
const ELEVENLABS_CREDITS_PER_CHAR: Record<string, number> = {
  eleven_flash_v2_5: 0.5,
  eleven_flash_v2: 0.5,
  eleven_turbo_v2_5: 0.5,
  eleven_turbo_v2: 0.5,
  eleven_multilingual_v2: 1,
  eleven_monolingual_v1: 1,
};

export class ElevenLabsTTS implements TTSProvider {
  readonly providerName = 'elevenlabs';
  readonly maxInputLength = ELEVENLABS_TTS_MAX_INPUT;

  constructor(
    private apiKey: string,
    private model: string,
    private voiceId: string,
  ) {
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is required for ElevenLabs TTS');
    if (!voiceId) throw new Error('ELEVENLABS_TTS_VOICE_ID is required for ElevenLabs TTS');
  }

  get modelName(): string {
    return this.model;
  }

  async synthesize(text: string): Promise<TTSResult> {
    const response = await withRetry(() => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'xi-api-key': this.apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: this.model,
        output_format: ELEVENLABS_OUTPUT_FORMAT,
      }),
    }));

    if (!response.ok) {
      const errorText = await response.text();
      const status = response.status;
      if (status === 401 || status === 403 || errorText.includes('quota') || errorText.includes('balance')) {
        throw new ApiBalanceError(`ElevenLabs TTS: ${status} ${errorText}`);
      }
      throw new Error(`ElevenLabs TTS error ${status}: ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const creditsPerChar = ELEVENLABS_CREDITS_PER_CHAR[this.model] ?? 1;

    return {
      audioBuffer: Buffer.from(arrayBuffer),
      mimeType: 'audio/mpeg',
      extension: 'mp3',
      usage: {
        charCount: text.length,
        creditsUsed: text.length * creditsPerChar,
      },
    };
  }
}

export class ApiBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiBalanceError';
  }
}
