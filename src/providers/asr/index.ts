import { config } from '../../config.js';
import { ElevenLabsASR } from './elevenlabs.js';
import { OpenAIASR } from './openai.js';

export interface ASRProvider {
  transcribe(audioBuffer: Buffer, lang: string): Promise<string>;
  readonly costPerMinute: number;
}

export interface NamedASRProvider extends ASRProvider {
  readonly name: string;
}

export function calcASRCost(durationSeconds: number, costPerMinute: number): number {
  return (durationSeconds / 60) * costPerMinute;
}

export function createASRProvider(): ASRProvider {
  switch (config.asr.provider) {
    case 'elevenlabs':
      return new ElevenLabsASR(config.keys.elevenlabs, config.asr.elevenlabsModel);
    case 'openai':
      return new OpenAIASR(config.keys.openai, config.asr.openaiModel);
    default:
      throw new Error(`Unknown ASR provider: ${config.asr.provider}`);
  }
}

export function createAllASRProviders(): NamedASRProvider[] {
  const providers: NamedASRProvider[] = [];
  if (config.keys.elevenlabs) {
    const p = new ElevenLabsASR(config.keys.elevenlabs, config.asr.elevenlabsModel);
    providers.push({ name: `ElevenLabs (${config.asr.elevenlabsModel})`, transcribe: p.transcribe.bind(p), costPerMinute: p.costPerMinute });
  }
  if (config.keys.openai) {
    const p = new OpenAIASR(config.keys.openai, config.asr.openaiModel);
    providers.push({ name: `OpenAI (${config.asr.openaiModel})`, transcribe: p.transcribe.bind(p), costPerMinute: p.costPerMinute });
  }
  return providers;
}
