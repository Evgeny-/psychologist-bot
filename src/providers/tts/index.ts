import { config } from '../../config.js';
import { ElevenLabsTTS } from './elevenlabs.js';
import { OpenAITTS } from './openai.js';

export interface TTSUsage {
  charCount: number;
  costUsd?: number;
  creditsUsed?: number;
}

export interface TTSResult {
  audioBuffer: Buffer;
  mimeType: string;
  extension: string;
  usage: TTSUsage;
}

export interface TTSProvider {
  synthesize(text: string): Promise<TTSResult>;
  readonly providerName: string;
  readonly modelName: string;
  readonly maxInputLength: number;
}

export function createTTSProvider(): TTSProvider {
  switch (config.tts.provider) {
    case 'elevenlabs':
      return new ElevenLabsTTS(
        config.keys.elevenlabs,
        config.tts.elevenlabsModel,
        config.tts.elevenlabsVoiceId,
      );
    case 'openai':
      return new OpenAITTS(
        config.keys.openai,
        config.tts.openaiModel,
        config.tts.openaiVoice,
      );
    default:
      throw new Error(`Unknown TTS provider: ${config.tts.provider}`);
  }
}
