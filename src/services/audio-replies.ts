import { InputFile, type Api } from 'grammy';
import { config } from '../config.js';
import { t } from '../i18n/index.js';
import { createTTSProvider, type TTSProvider, type TTSResult } from '../providers/tts/index.js';
import { OpenAITTS } from '../providers/tts/openai.js';
import { splitMessage } from '../utils/telegram.js';

interface AudioReplyMeta {
  primaryProviderLabel: string;
  providerLabel: string;
  fallbackUsed: boolean;
  totalChars: number;
  totalCostUsd?: number;
  totalCredits?: number;
}

function createFallbackTTS(): TTSProvider | null {
  if (config.tts.provider === 'elevenlabs' && config.keys.openai) {
    return new OpenAITTS(
      config.keys.openai,
      config.tts.openaiModel,
      config.tts.openaiVoice,
      config.tts.openaiSpeed,
    );
  }
  return null;
}

function providerLabel(tts: TTSProvider): string {
  return tts.providerName;
}

function configuredPrimaryProviderLabel(): string {
  return config.tts.provider;
}

function formatCredits(credits: number): string {
  return Number.isInteger(credits) ? String(credits) : credits.toFixed(1);
}

function buildCaption(meta: AudioReplyMeta, index: number, total: number): string {
  if (index > 0) {
    return total > 1 ? `${meta.providerLabel} | ${index + 1}/${total}` : meta.providerLabel;
  }

  const parts = [meta.providerLabel];

  if (meta.totalCostUsd !== undefined) {
    parts.push(`$${meta.totalCostUsd.toFixed(5)}`);
  }
  if (meta.totalCredits !== undefined) {
    parts.push(`${formatCredits(meta.totalCredits)} credits`);
  }

  if (total > 1) {
    parts.push(`${index + 1}/${total}`);
  }

  let caption = parts.join(' | ');
  if (meta.fallbackUsed) {
    caption += `\n${t().audioFallbackNotice.replace('{provider}', meta.primaryProviderLabel)}`;
  }
  return caption;
}

async function synthesizeChunks(tts: TTSProvider, chunks: string[]): Promise<TTSResult[]> {
  const results: TTSResult[] = [];
  for (const chunk of chunks) {
    results.push(await tts.synthesize(chunk));
  }
  return results;
}

function summarizeUsage(tts: TTSProvider, primaryProviderLabel: string, fallbackUsed: boolean, results: TTSResult[]): AudioReplyMeta {
  return {
    primaryProviderLabel,
    providerLabel: providerLabel(tts),
    fallbackUsed,
    totalChars: results.reduce((sum, result) => sum + result.usage.charCount, 0),
    totalCostUsd: results.some((result) => result.usage.costUsd !== undefined)
      ? results.reduce((sum, result) => sum + (result.usage.costUsd ?? 0), 0)
      : undefined,
    totalCredits: results.some((result) => result.usage.creditsUsed !== undefined)
      ? results.reduce((sum, result) => sum + (result.usage.creditsUsed ?? 0), 0)
      : undefined,
  };
}

export async function sendAudioReply(
  api: Api,
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<number[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const fallbackTTS = createFallbackTTS();

  let primaryTTS: TTSProvider;
  let fallbackUsed = false;

  try {
    primaryTTS = createTTSProvider();
  } catch (err) {
    if (!fallbackTTS) throw err;

    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`TTS primary unavailable (${reason}), using OpenAI`);

    primaryTTS = fallbackTTS;
    fallbackUsed = true;
  }

  const maxInputLength = Math.min(
    primaryTTS.maxInputLength,
    fallbackTTS?.maxInputLength ?? primaryTTS.maxInputLength,
  );
  const chunks = splitMessage(trimmed, maxInputLength);

  const primaryProviderLabel = configuredPrimaryProviderLabel();
  let results: TTSResult[];

  try {
    results = await synthesizeChunks(primaryTTS, chunks);
  } catch (err) {
    if (!fallbackTTS || primaryTTS === fallbackTTS) throw err;

    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`TTS fallback: ${primaryProviderLabel} failed (${reason}), using OpenAI`);

    primaryTTS = fallbackTTS;
    fallbackUsed = true;
    results = await synthesizeChunks(primaryTTS, chunks);
  }

  const meta = summarizeUsage(primaryTTS, primaryProviderLabel, fallbackUsed, results);
  const messageIds: number[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const msg = await api.sendAudio(
      chatId,
      new InputFile(result.audioBuffer, `reply-${i + 1}.${result.extension}`),
      {
        reply_to_message_id: replyToMessageId,
        caption: buildCaption(meta, i, results.length),
      },
    );
    messageIds.push(msg.message_id);
  }

  return messageIds;
}
