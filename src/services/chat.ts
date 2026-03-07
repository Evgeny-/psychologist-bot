import type { Api } from 'grammy';
import { createLLMProvider, createAllLLMProviders, type ChatMessage } from '../providers/llm/index.js';
import { getChatSystemPrompt } from '../prompts/chat.js';
import { config } from '../config.js';
import { sendSplitMessages } from '../utils/telegram.js';
import { queries } from '../db/index.js';

export async function handleThreadReply(
  api: Api,
  chatId: number,
  threadId: number,
  userMessage: string,
  replyToMessageId?: number,
): Promise<void> {
  const systemPrompt = getChatSystemPrompt(config.language);

  // Load conversation history from DB
  const history = queries.getThreadMessages(threadId);
  const messages: ChatMessage[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Add current user message
  messages.push({ role: 'user', content: userMessage });

  // Save user message to thread
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

  // Save assistant response to thread
  queries.insertThreadMessage({
    thread_id: threadId,
    role: 'assistant',
    content: result.text,
    llm_provider: llm.providerName,
    llm_model: llm.modelName,
  });

  const costLine = result.usage ? `\n\n💰 $${result.usage.costUsd.toFixed(5)} (${result.usage.inputTokens}in/${result.usage.outputTokens}out)` : '';
  await sendSplitMessages(api, chatId, `${result.text}${costLine}`, replyToMessageId);
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

      // Save first successful response to thread for context continuity
      if (i === 0) {
        queries.insertThreadMessage({
          thread_id: threadId,
          role: 'assistant',
          content: result.text,
          llm_provider: llm.providerName,
          llm_model: llm.modelName,
        });
      }

      const usage = result.usage
        ? ` | ${result.usage.inputTokens}in/${result.usage.outputTokens}out | $${result.usage.costUsd.toFixed(5)}`
        : '';
      const header = `--- ${label} | ${elapsed}s${usage} ---`;
      await sendSplitMessages(api, chatId, `${header}\n\n${result.text}`, replyToMessageId);
    } else {
      const errMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      await sendSplitMessages(api, chatId, `--- ${label} ---\n\nError: ${errMsg}`, replyToMessageId);
    }
  }
}
