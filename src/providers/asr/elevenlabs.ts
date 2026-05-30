import type { ASRProvider } from './index.js';
import { withRetry } from '../../utils/retry.js';

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
    // Disable non-speech tagging so the transcript does not contain things
    // like "(laughter)" or "(footsteps)" that would confuse the diary LLM.
    // See https://elevenlabs.io/docs/api-reference/speech-to-text/convert
    formData.append('tag_audio_events', 'false');
    // Strip filler words ("hmm", "a-a-a"), false starts and other non-speech
    // sounds. Only supported by scribe_v2; sending it to scribe_v1 would be
    // rejected, so gate on the configured model.
    if (this.model === 'scribe_v2') {
      formData.append('no_verbatim', 'true');
    }

    const response = await withRetry(() => fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
      },
      body: formData,
    }));

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
