import type { Api } from 'grammy';
import { createLLMProvider, createAllLLMProviders, type LLMProvider, type LLMUsage } from '../providers/llm/index.js';
import { getDailySystemPrompt } from '../prompts/daily.js';
import { todayLocal } from '../utils/date.js';
import { config } from '../config.js';
import { t } from '../i18n/index.js';
import { sendRawHtmlMessages, markdownToHtml } from '../utils/telegram.js';
import { queries } from '../db/index.js';

interface AnalysisResult {
  sentiment?: string;
  distortions?: Array<{ type: string; quote: string; reframe: string }>;
  gratitude?: string[];
  action_items?: string[];
  topics?: string[];
  gratitude_count?: number;
}

function parseAnalysisJson(text: string): AnalysisResult | null {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as AnalysisResult;
  } catch {
    return null;
  }
}

function extractFreeformAnalysis(text: string): string {
  const afterJson = text.replace(/```json\s*[\s\S]*?\s*```/, '').trim();
  return afterJson || text;
}

function saveAnalysis(entryId: number, responseText: string, llm: LLMProvider): void {
  const parsed = parseAnalysisJson(responseText);
  const freeform = extractFreeformAnalysis(responseText);

  queries.insertAnalysis({
    entry_id: entryId,
    analysis_text: freeform,
    sentiment: parsed?.sentiment,
    distortions_json: parsed?.distortions ? JSON.stringify(parsed.distortions) : undefined,
    topics_json: parsed?.topics ? JSON.stringify(parsed.topics) : undefined,
    action_items_json: parsed?.action_items ? JSON.stringify(parsed.action_items) : undefined,
    gratitude_count: parsed?.gratitude_count ?? parsed?.gratitude?.length ?? 0,
    llm_provider: llm.providerName,
    llm_model: llm.modelName,
  });
}

function formatUsage(usage?: LLMUsage): string {
  if (!usage) return '';
  return ` | ${usage.inputTokens}in/${usage.outputTokens}out | $${usage.costUsd.toFixed(5)}`;
}

function buildUserPromptWithContext(text: string, date: string, entryId: number): string {
  const earlier = queries.getEarlierEntriesForDate(date, entryId);
  if (earlier.length === 0) return text;

  const contextParts = earlier.map((e, i) => {
    const entryText = e.transcript || e.raw_text || '';
    let part = `[Earlier entry ${i + 1}]\n${entryText}`;
    if (e.analysis_text) {
      part += `\n\n[Your previous analysis]\n${e.analysis_text}`;
    }
    return part;
  });

  const contextBlock = config.language === 'ru'
    ? `--- КОНТЕКСТ: предыдущие записи за сегодня (только для справки, НЕ анализируй их повторно) ---\n\n${contextParts.join('\n\n---\n\n')}\n\n--- ТЕКУЩАЯ ЗАПИСЬ (анализируй именно её) ---\n\n`
    : `--- CONTEXT: earlier entries from today (for reference only, do NOT re-analyze them) ---\n\n${contextParts.join('\n\n---\n\n')}\n\n--- CURRENT ENTRY (analyze this one) ---\n\n`;

  return contextBlock + text;
}

export async function analyzeEntry(
  api: Api,
  chatId: number,
  entryId: number,
  text: string,
  threadId: number,
  replyToMessageId?: number,
  date?: string,
): Promise<void> {
  const systemPrompt = getDailySystemPrompt(config.language);
  const entryDate = date || todayLocal();
  const userPrompt = buildUserPromptWithContext(text, entryDate, entryId);

  // Save user's diary entry as first thread message
  queries.insertThreadMessage({
    thread_id: threadId,
    role: 'user',
    content: text,
  });

  if (config.compareMode) {
    await analyzeCompare(api, chatId, entryId, userPrompt, systemPrompt, threadId, replyToMessageId);
    return;
  }

  const llm = createLLMProvider();
  const result = await llm.analyze(userPrompt, systemPrompt);

  saveAnalysis(entryId, result.text, llm);

  // Save analysis as assistant message in thread
  const freeform = extractFreeformAnalysis(result.text);
  queries.insertThreadMessage({
    thread_id: threadId,
    role: 'assistant',
    content: freeform,
    llm_provider: llm.providerName,
    llm_model: llm.modelName,
  });

  const costInfo = result.usage ? ` | $${result.usage.costUsd.toFixed(5)}` : '';
  const meta = `<blockquote>${t().analysisHeader}${costInfo}</blockquote>`;
  const body = markdownToHtml(freeform);
  await sendRawHtmlMessages(api, chatId, `${meta}\n\n${body}`, replyToMessageId);
}

async function analyzeCompare(
  api: Api,
  chatId: number,
  entryId: number,
  text: string,
  systemPrompt: string,
  threadId: number,
  replyToMessageId?: number,
): Promise<void> {
  const providers = createAllLLMProviders();

  const results = await Promise.allSettled(
    providers.map(async (llm) => {
      const start = Date.now();
      const result = await llm.analyze(text, systemPrompt);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      return { result, llm, elapsed };
    }),
  );

  let threadSaved = false;

  for (let i = 0; i < results.length; i++) {
    const settled = results[i];
    const provider = providers[i];
    const label = `${provider.providerName} (${provider.modelName})`;

    if (settled.status === 'fulfilled') {
      const { result, llm, elapsed } = settled.value;
      saveAnalysis(entryId, result.text, llm);

      const freeform = extractFreeformAnalysis(result.text);

      // Save first successful provider's response as thread context for follow-up chat
      if (!threadSaved) {
        queries.insertThreadMessage({
          thread_id: threadId,
          role: 'assistant',
          content: freeform,
          llm_provider: llm.providerName,
          llm_model: llm.modelName,
        });
        threadSaved = true;
      }
      const meta = `<blockquote>${label} | ${elapsed}s${formatUsage(result.usage)}</blockquote>`;
      const body = markdownToHtml(freeform);
      await sendRawHtmlMessages(api, chatId, `${meta}\n\n${body}`, replyToMessageId);
    } else {
      const errMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      await sendRawHtmlMessages(api, chatId, `<blockquote>${label}</blockquote>\n\nError: ${errMsg}`, replyToMessageId);
    }
  }
}
