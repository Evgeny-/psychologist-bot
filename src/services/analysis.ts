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
  metrics?: {
    mood?: number | null;
    anxiety?: number | null;
    self_esteem?: number | null;
    productivity?: number | null;
  };
}

export interface ExtractedMetrics {
  mood?: number;
  anxiety?: number;
  self_esteem?: number;
  productivity?: number;
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

function extractMetrics(parsed: AnalysisResult | null): ExtractedMetrics {
  const m = parsed?.metrics;
  if (!m) return {};
  const result: ExtractedMetrics = {};
  if (typeof m.mood === 'number' && m.mood >= 0 && m.mood <= 10) result.mood = m.mood;
  if (typeof m.anxiety === 'number' && m.anxiety >= 0 && m.anxiety <= 10) result.anxiety = m.anxiety;
  if (typeof m.self_esteem === 'number' && m.self_esteem >= 0 && m.self_esteem <= 10) result.self_esteem = m.self_esteem;
  if (typeof m.productivity === 'number' && m.productivity >= 0 && m.productivity <= 10) result.productivity = m.productivity;
  return result;
}

function saveAnalysis(entryId: number, responseText: string, llm: LLMProvider): ExtractedMetrics {
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

  return extractMetrics(parsed);
}

function formatUsage(usage?: LLMUsage): string {
  if (!usage) return '';
  return ` | ${usage.inputTokens}in/${usage.outputTokens}out | $${usage.costUsd.toFixed(5)}`;
}

function formatMetricsLine(metrics: ExtractedMetrics): string {
  const parts: string[] = [];
  if (metrics.mood !== undefined) parts.push(`настроение: ${metrics.mood}`);
  if (metrics.anxiety !== undefined) parts.push(`тревога: ${metrics.anxiety}`);
  if (metrics.self_esteem !== undefined) parts.push(`самооценка: ${metrics.self_esteem}`);
  if (metrics.productivity !== undefined) parts.push(`продуктивность: ${metrics.productivity}`);
  if (parts.length === 0) return '';
  return `\n<blockquote>📊 ${parts.join(' | ')}</blockquote>`;
}

function getYesterdayDate(date: string): string {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function buildUserPromptWithContext(text: string, date: string, entryId: number): string {
  const earlier = queries.getEarlierEntriesForDate(date, entryId);
  const yesterday = getYesterdayDate(date);
  const yesterdayEntries = queries.getEntriesByDateRange(yesterday, yesterday);

  const sections: string[] = [];

  let yesterdayBlock: string | null = null;
  if (yesterdayEntries.length > 0) {
    const yesterdayTranscripts = yesterdayEntries
      .map((e, i) => `[Вчерашняя запись ${i + 1}]\n${e.transcript || e.raw_text || ''}`)
      .join('\n\n---\n\n');
    yesterdayBlock = config.language === 'ru'
      ? `--- КОНТЕКСТ: записи ЗА ВЧЕРА (только для фоновой связи мыслей, НЕ анализируй их, НЕ упоминай явно) ---\n\n${yesterdayTranscripts}\n\n--- КОНЕЦ ВЧЕРАШНЕГО КОНТЕКСТА ---`
      : `--- BACKGROUND CONTEXT: yesterday's entries (for continuity only — do NOT analyze them, do NOT reference them explicitly) ---\n\n${yesterdayTranscripts}\n\n--- END YESTERDAY CONTEXT ---`;
  }

  let earlierBlock: string | null = null;
  if (earlier.length > 0) {
    const contextParts = earlier.map((e, i) => {
      const entryText = e.transcript || e.raw_text || '';
      let part = `[Earlier entry ${i + 1}]\n${entryText}`;
      if (e.analysis_text) {
        part += `\n\n[Your previous analysis]\n${e.analysis_text}`;
      }
      return part;
    });
    earlierBlock = config.language === 'ru'
      ? `--- КОНТЕКСТ: предыдущие записи за сегодня (только для справки, НЕ анализируй их повторно) ---\n\n${contextParts.join('\n\n---\n\n')}\n\n--- ТЕКУЩАЯ ЗАПИСЬ (анализируй именно её) ---`
      : `--- CONTEXT: earlier entries from today (for reference only, do NOT re-analyze them) ---\n\n${contextParts.join('\n\n---\n\n')}\n\n--- CURRENT ENTRY (analyze this one) ---`;
  }

  if (yesterdayBlock) {
    const estimatedTotal = text.length + yesterdayBlock.length + (earlierBlock?.length ?? 0);
    if (estimatedTotal <= 100_000) {
      sections.push(yesterdayBlock);
    }
  }

  if (earlierBlock) sections.push(earlierBlock);

  if (sections.length === 0) return text;

  return sections.join('\n\n') + '\n\n' + text;
}

function buildSystemPromptWithMemory(basePrompt: string): string {
  const memory = queries.getMemory();
  if (!memory) return basePrompt;
  const label = config.language === 'ru'
    ? '--- ПАМЯТЬ О ПОЛЬЗОВАТЕЛЕ (используй как контекст, не упоминай явно) ---'
    : '--- USER MEMORY (use as context, do not mention explicitly) ---';
  return `${basePrompt}\n\n${label}\n${memory}\n---`;
}

export async function analyzeEntry(
  api: Api,
  chatId: number,
  entryId: number,
  text: string,
  threadId: number,
  replyToMessageId?: number,
  date?: string,
): Promise<ExtractedMetrics> {
  const systemPrompt = buildSystemPromptWithMemory(getDailySystemPrompt(config.language));
  const entryDate = date || todayLocal();
  const userPrompt = buildUserPromptWithContext(text, entryDate, entryId);

  // Save user's diary entry as first thread message
  queries.insertThreadMessage({
    thread_id: threadId,
    role: 'user',
    content: text,
  });

  if (config.compareMode) {
    return analyzeCompare(api, chatId, entryId, userPrompt, systemPrompt, threadId, replyToMessageId);
  }

  const llm = createLLMProvider();
  const result = await llm.analyze(userPrompt, systemPrompt);

  const metrics = saveAnalysis(entryId, result.text, llm);

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
  const metricsLine = formatMetricsLine(metrics);
  await sendRawHtmlMessages(api, chatId, `${meta}\n\n${body}${metricsLine}`, replyToMessageId);
  return metrics;
}

async function analyzeCompare(
  api: Api,
  chatId: number,
  entryId: number,
  text: string,
  systemPrompt: string,
  threadId: number,
  replyToMessageId?: number,
): Promise<ExtractedMetrics> {
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
  let firstMetrics: ExtractedMetrics = {};

  for (let i = 0; i < results.length; i++) {
    const settled = results[i];
    const provider = providers[i];
    const label = `${provider.providerName} (${provider.modelName})`;

    if (settled.status === 'fulfilled') {
      const { result, llm, elapsed } = settled.value;
      const metrics = saveAnalysis(entryId, result.text, llm);

      if (!threadSaved) {
        firstMetrics = metrics;
      }

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
      const metricsLine = formatMetricsLine(metrics);
      await sendRawHtmlMessages(api, chatId, `${meta}\n\n${body}${metricsLine}`, replyToMessageId);
    } else {
      const errMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      await sendRawHtmlMessages(api, chatId, `<blockquote>${label}</blockquote>\n\nError: ${errMsg}`, replyToMessageId);
    }
  }

  return firstMetrics;
}
