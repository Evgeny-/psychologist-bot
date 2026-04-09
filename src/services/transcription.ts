import type { Api } from 'grammy';
import { createASRProvider, calcASRCost, type ASRProvider } from '../providers/asr/index.js';
import { OpenAIASR } from '../providers/asr/openai.js';
import { downloadFileBuffer, sendRawHtmlMessages, markdownToHtml } from '../utils/telegram.js';
import { config } from '../config.js';
import { t } from '../i18n/index.js';
import { logInfo, logWarn } from '../utils/logger.js';

function createFallbackASR(): ASRProvider | null {
  if (config.asr.provider === 'elevenlabs' && config.keys.openai) {
    return new OpenAIASR(config.keys.openai, config.asr.openaiModel);
  }
  return null;
}

export async function transcribeVoiceMessage(
  api: Api,
  chatId: number,
  fileId: string,
  durationSeconds: number,
  replyToMessageId?: number,
): Promise<{ transcript: string; messageIds: number[] }> {
  const start = Date.now();
  const audioBuffer = await downloadFileBuffer(api, fileId);
  const langCode = config.language === 'ru' ? 'ru' : 'en';

  const primaryASR = createASRProvider();
  let asr = primaryASR;
  let fallbackUsed = false;
  let fallbackReason = '';

  let transcript: string;
  logInfo('asr.transcription.start', {
    chatId,
    replyToMessageId,
    durationSeconds,
    fileId,
    audioBytes: audioBuffer.length,
    language: langCode,
    primaryProvider: config.asr.provider,
  });

  try {
    transcript = await primaryASR.transcribe(audioBuffer, langCode);
  } catch (err) {
    const fallbackASR = createFallbackASR();
    if (!fallbackASR) throw err;

    fallbackReason = err instanceof Error ? err.message : String(err);
    logWarn('asr.transcription.fallback', {
      chatId,
      replyToMessageId,
      primaryProvider: config.asr.provider,
      fallbackProvider: 'openai',
      reason: fallbackReason,
    });

    asr = fallbackASR;
    fallbackUsed = true;
    transcript = await fallbackASR.transcribe(audioBuffer, langCode);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const cost = calcASRCost(durationSeconds, asr.costPerMinute);
  let metaInfo = `${t().transcriptHeader} | $${cost.toFixed(5)} | ${elapsed}s`;
  if (fallbackUsed) {
    metaInfo += `\n⚠️ ${config.asr.provider} failed, used OpenAI fallback`;
  }
  const meta = `<blockquote>${metaInfo}</blockquote>`;
  const body = markdownToHtml(transcript.trim());

  const messageIds = await sendRawHtmlMessages(api, chatId, `${meta}\n\n${body}`, replyToMessageId);
  logInfo('asr.transcription.complete', {
    chatId,
    replyToMessageId,
    durationSeconds,
    provider: fallbackUsed ? 'openai' : config.asr.provider,
    fallbackUsed,
    transcriptChars: transcript.length,
    elapsedMs: Date.now() - start,
    transcriptMessageCount: messageIds.length,
    costUsd: cost.toFixed(5),
  });
  return { transcript, messageIds };
}
