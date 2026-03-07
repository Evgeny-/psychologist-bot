import type { ASRProvider } from './index.js';

// $0.40/hour = $0.00667/min for scribe_v2
const ELEVENLABS_COST_PER_MINUTE = 0.00667;

export class ElevenLabsASR implements ASRProvider {
  readonly costPerMinute = ELEVENLABS_COST_PER_MINUTE;

  constructor(
    private apiKey: string,
    private model: string,
  ) {}

  async transcribe(audioBuffer: Buffer, lang: string): Promise<string> {
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(audioBuffer)], { type: 'audio/ogg' }), 'audio.ogg');
    formData.append('model_id', this.model);
    formData.append('language_code', lang);

    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const status = response.status;
      if (status === 401 || status === 403 || errorText.includes('quota') || errorText.includes('balance')) {
        throw new ApiBalanceError(`ElevenLabs ASR: ${status} ${errorText}`);
      }
      throw new Error(`ElevenLabs ASR error ${status}: ${errorText}`);
    }

    const data = await response.json() as { text: string };
    return data.text;
  }
}

export class ApiBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiBalanceError';
  }
}
