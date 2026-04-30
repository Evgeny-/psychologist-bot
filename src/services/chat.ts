import type { Api } from 'grammy';
import { createLLMProvider, createAllLLMProviders, type ChatMessage } from '../providers/llm/index.js';
import { getChatSystemPrompt } from '../prompts/chat.js';
import { config } from '../config.js';
import { sendRawHtmlMessages, markdownToHtml } from '../utils/telegram.js';
import { queries } from '../db/index.js';
import { sendAudioReply } from './audio-replies.js';
import { buildSystemPromptWithUserMemory } from './memory-context.js';
import { t } from '../i18n/index.js';
import { todayLocal } from '../utils/date.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';

interface ChatResponseEnvelope {
  text?: string;
  reply_audio_requested?: boolean;
}

interface ParsedChatResponse {
  text: string;
  wantsAudioReply: boolean;
  parsedJson: boolean;
}

function parseChatResponseJson(text: string): ChatResponseEnvelope | null {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonText = match ? match[1] : text;
  try {
    return JSON.parse(jsonText) as ChatResponseEnvelope;
  } catch {
    return null;
  }
}

function parseChatResponse(text: string): ParsedChatResponse {
  const parsed = parseChatResponseJson(text);
  const messageText = typeof parsed?.text === 'string' && parsed.text.trim()
    ? parsed.text.trim()
    : text.replace(/```json\s*[\s\S]*?\s*```/, '').trim() || text.trim();

  return {
    text: messageText,
    wantsAudioReply: parsed?.reply_audio_requested === true,
    parsedJson: parsed !== null,
  };
}

export async function handleThreadReply(
  api: Api,
  chatId: number,
  threadId: number,
  userMessage: string,
  replyToMessageId?: number,
): Promise<void> {
  const systemPrompt = buildSystemPromptWithUserMemory(
    getChatSystemPrompt(config.language),
    todayLocal(),
    { includeReferenceDate: true },
  );

  const history = queries.getThreadMessages(threadId);
  const messages: ChatMessage[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  messages.push({ role: 'user', content: userMessage });

  queries.insertThreadMessage({
    thread_id: threadId,
    role: 'user',
    content: userMessage,
  });
  logInfo('llm.chat.start', {
    chatId,
    threadId,
    replyToMessageId,
    historyMessages: history.length,
    historyChars: history.reduce((sum, msg) => sum + msg.content.length, 0),
    userChars: userMessage.length,
    systemChars: systemPrompt.length,
    compareMode: config.compareMode,
  });

  if (config.compareMode) {
    await chatCompare(api, chatId, threadId, messages, systemPrompt, replyToMessageId);
    return;
  }

  const llm = createLLMProvider();
  const start = Date.now();
  const result = await llm.chat(messages, systemPrompt);
  const parsedResponse = parseChatResponse(result.text);
  const text = parsedResponse.text;
  if (!parsedResponse.parsedJson) {
    logWarn('llm.chat.parse_fallback', {
      chatId,
      threadId,
      provider: llm.providerName,
      model: llm.modelName,
      outputChars: result.text.length,
    });
  }

  queries.insertThreadMessage({
    thread_id: threadId,
    role: 'assistant',
    content: text,
    llm_provider: llm.providerName,
    llm_model: llm.modelName,
  });

  const costInfo = result.usage ? ` | $${result.usage.costUsd.toFixed(5)}` : '';
  const meta = `<blockquote>${llm.providerName} (${llm.modelName})${costInfo}</blockquote>`;
  const body = markdownToHtml(text);
  await sendRawHtmlMessages(api, chatId, `${meta}\n\n${body}`, replyToMessageId);
  logInfo('llm.chat.complete', {
    chatId,
    threadId,
    replyToMessageId,
    provider: llm.providerName,
    model: llm.modelName,
    elapsedMs: Date.now() - start,
    outputChars: text.length,
    parsedJson: parsedResponse.parsedJson,
    wantsAudioReply: parsedResponse.wantsAudioReply,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    costUsd: result.usage?.costUsd?.toFixed(5),
  });

  if (parsedResponse.wantsAudioReply) {
    await sendAudioReply(api, chatId, text, replyToMessageId).catch(async (err) => {
      logError('tts.reply.failed', err, { chatId, threadId, replyToMessageId });
      await sendRawHtmlMessages(api, chatId, t().audioReplyUnavailable, replyToMessageId).catch(() => {});
    });
  }
}

async function chatCompare(
  api: Api,
  chatId: number,
  threadId: number,
  messages: ChatMessage[],
  systemPrompt: string,
  replyToMessageId?: number,
): Promise<void> {
  const providers = createAllLLMProviders();

  const results = await Promise.allSettled(
    providers.map(async (llm) => {
      const start = Date.now();
      const result = await llm.chat(messages, systemPrompt);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      return { result, llm, elapsed };
    }),
  );

  let threadSaved = false;
  let audioSent = false;

  for (let i = 0; i < results.length; i++) {
    const settled = results[i];
    const provider = providers[i];
    const label = `${provider.providerName} (${provider.modelName})`;

    if (settled.status === 'fulfilled') {
      const { result, llm, elapsed } = settled.value;
      const parsedResponse = parseChatResponse(result.text);
      const text = parsedResponse.text;
      if (!parsedResponse.parsedJson) {
        logWarn('llm.chat.compare_parse_fallback', {
          chatId,
          threadId,
          provider: llm.providerName,
          model: llm.modelName,
          outputChars: result.text.length,
        });
      }

      // Save first successful provider's response to thread for context continuity
      if (!threadSaved) {
        queries.insertThreadMessage({
          thread_id: threadId,
          role: 'assistant',
          content: text,
          llm_provider: llm.providerName,
          llm_model: llm.modelName,
        });
        threadSaved = true;
      }

      const usage = result.usage
        ? ` | ${result.usage.inputTokens}in/${result.usage.outputTokens}out | $${result.usage.costUsd.toFixed(5)}`
        : '';
      const meta = `<blockquote>${label} | ${elapsed}s${usage}</blockquote>`;
      const body = markdownToHtml(text);
      await sendRawHtmlMessages(api, chatId, `${meta}\n\n${body}`, replyToMessageId);
      logInfo('llm.chat.compare_complete', {
        chatId,
        threadId,
        replyToMessageId,
        provider: llm.providerName,
        model: llm.modelName,
        elapsedSec: elapsed,
        outputChars: text.length,
        parsedJson: parsedResponse.parsedJson,
        wantsAudioReply: parsedResponse.wantsAudioReply,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        costUsd: result.usage?.costUsd?.toFixed(5),
      });

      if (parsedResponse.wantsAudioReply && !audioSent) {
        await sendAudioReply(api, chatId, text, replyToMessageId).catch(async (err) => {
          logError('tts.reply.failed', err, { chatId, threadId, replyToMessageId });
          await sendRawHtmlMessages(api, chatId, t().audioReplyUnavailable, replyToMessageId).catch(() => {});
        });
        audioSent = true;
      }
    } else {
      const errMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      logError('llm.chat.compare_failed', settled.reason, {
        chatId,
        threadId,
        replyToMessageId,
        provider: provider.providerName,
        model: provider.modelName,
      });
      await sendRawHtmlMessages(api, chatId, `<blockquote>${label}</blockquote>\n\nError: ${errMsg}`, replyToMessageId);
    }
  }
}
