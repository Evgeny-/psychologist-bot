import type { Api } from 'grammy';
import { createLLMProvider, createAllLLMProviders, type ChatMessage } from '../providers/llm/index.js';
import { getChatSystemPrompt } from '../prompts/chat.js';
import { config } from '../config.js';
import { sendRawHtmlMessages, markdownToHtml } from '../utils/telegram.js';
import { queries } from '../db/index.js';

export async function handleThreadReply(
  api: Api,
  chatId: number,
  threadId: number,
  userMessage: string,
  replyToMessageId?: number,
): Promise<void> {
  const systemPrompt = getChatSystemPrompt(config.language);

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

  if (config.compareMode) {
    await chatCompare(api, chatId, threadId, messages, systemPrompt, replyToMessageId);
    return;
  }

  const llm = createLLMProvider();
  const result = await llm.chat(messages, systemPrompt);
  const text = result.text.trim();

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

  for (let i = 0; i < results.length; i++) {
    const settled = results[i];
    const provider = providers[i];
    const label = `${provider.providerName} (${provider.modelName})`;

    if (settled.status === 'fulfilled') {
      const { result, llm, elapsed } = settled.value;
      const text = result.text.trim();

      if (i === 0) {
        queries.insertThreadMessage({
          thread_id: threadId,
          role: 'assistant',
          content: text,
          llm_provider: llm.providerName,
          llm_model: llm.modelName,
        });
      }

      const usage = result.usage
        ? ` | ${result.usage.inputTokens}in/${result.usage.outputTokens}out | $${result.usage.costUsd.toFixed(5)}`
        : '';
      const meta = `<blockquote>${label} | ${elapsed}s${usage}</blockquote>`;
      const body = markdownToHtml(text);
      await sendRawHtmlMessages(api, chatId, `${meta}\n\n${body}`, replyToMessageId);
    } else {
      const errMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      await sendRawHtmlMessages(api, chatId, `<blockquote>${label}</blockquote>\n\nError: ${errMsg}`, replyToMessageId);
    }
  }
}
