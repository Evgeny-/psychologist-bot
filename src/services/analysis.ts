import type { Api } from 'grammy';
import { createLLMProvider, createAllLLMProviders, type LLMProvider, type LLMUsage } from '../providers/llm/index.js';
import { getDailySystemPrompt } from '../prompts/daily.js';
import { todayLocal, shiftLocalDate } from '../utils/date.js';
import { config } from '../config.js';
import { t } from '../i18n/index.js';
import { sendRawHtmlMessages, markdownToHtml } from '../utils/telegram.js';
import { queries } from '../db/index.js';
import { sendAudioReply } from './audio-replies.js';
import { buildSystemPromptWithUserMemory, sanitizeDailyMemorySummary } from './memory-context.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';

interface AnalysisResult {
  sentiment?: string;
  emotions?: string[];
  triggers?: string[];
  wins?: string[];
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
  daily_memory_summary?: string;
  analysis_text?: string;
  reply_audio_requested?: boolean;
}

export interface ExtractedMetrics {
  mood?: number;
  anxiety?: number;
  self_esteem?: number;
  productivity?: number;
}

interface ParsedAnalysisResponse {
  parsed: AnalysisResult | null;
  freeform: string;
  metrics: ExtractedMetrics;
  wantsAudioReply: boolean;
  parsedJson: boolean;
}

function parseAnalysisJson(text: string): AnalysisResult | null {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonText = match ? match[1] : text;
  try {
    return JSON.parse(jsonText) as AnalysisResult;
  } catch {
    return null;
  }
}

function extractFreeformAnalysis(text: string, parsed: AnalysisResult | null): string {
  if (typeof parsed?.analysis_text === 'string' && parsed.analysis_text.trim()) {
    return parsed.analysis_text.trim();
  }
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

function parseAnalysisResponse(responseText: string): ParsedAnalysisResponse {
  const parsed = parseAnalysisJson(responseText);
  const freeform = extractFreeformAnalysis(responseText, parsed);
  const metrics = extractMetrics(parsed);

  return {
    parsed,
    freeform,
    metrics,
    wantsAudioReply: parsed?.reply_audio_requested === true,
    parsedJson: parsed !== null,
  };
}

function saveAnalysis(entryId: number, response: ParsedAnalysisResponse, llm: LLMProvider): ExtractedMetrics {
  const { parsed, freeform, metrics } = response;

  queries.insertAnalysis({
    entry_id: entryId,
    analysis_text: freeform,
    sentiment: parsed?.sentiment,
    distortions_json: parsed?.distortions?.length ? JSON.stringify(parsed.distortions) : undefined,
    topics_json: parsed?.topics?.length ? JSON.stringify(parsed.topics) : undefined,
    action_items_json: parsed?.action_items?.length ? JSON.stringify(parsed.action_items) : undefined,
    emotions_json: parsed?.emotions?.length ? JSON.stringify(parsed.emotions) : undefined,
    triggers_json: parsed?.triggers?.length ? JSON.stringify(parsed.triggers) : undefined,
    wins_json: parsed?.wins?.length ? JSON.stringify(parsed.wins) : undefined,
    gratitude_count: parsed?.gratitude_count ?? parsed?.gratitude?.length ?? 0,
    llm_provider: llm.providerName,
    llm_model: llm.modelName,
  });

  return metrics;
}

function saveDailyMemorySummary(date: string, entryId: number, parsed: AnalysisResult | null, llm: LLMProvider): boolean {
  if (typeof parsed?.daily_memory_summary !== 'string') return false;
  const summary = sanitizeDailyMemorySummary(parsed.daily_memory_summary);
  if (!summary) return false;

  queries.upsertDailyMemory({
    date,
    summary,
    source_entry_id: entryId,
    llm_provider: llm.providerName,
    llm_model: llm.modelName,
  });
  return true;
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
  return shiftLocalDate(date, -1);
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

export async function analyzeEntry(
  api: Api,
  chatId: number,
  entryId: number,
  text: string,
  threadId: number,
  replyToMessageId?: number,
  date?: string,
): Promise<ExtractedMetrics> {
  const entryDate = date || todayLocal();
  const systemPrompt = buildSystemPromptWithUserMemory(
    getDailySystemPrompt(config.language),
    entryDate,
    { includeReferenceDate: false },
  );
  const userPrompt = buildUserPromptWithContext(text, entryDate, entryId);

  // Save user's diary entry as first thread message
  queries.insertThreadMessage({
    thread_id: threadId,
    role: 'user',
    content: text,
  });
  logInfo('llm.analysis.start', {
    chatId,
    entryId,
    threadId,
    replyToMessageId,
    entryDate,
    inputChars: text.length,
    promptChars: userPrompt.length,
    systemChars: systemPrompt.length,
    compareMode: config.compareMode,
  });

  if (config.compareMode) {
    return analyzeCompare(api, chatId, entryId, entryDate, userPrompt, systemPrompt, threadId, replyToMessageId);
  }

  const llm = createLLMProvider();
  const start = Date.now();
  const result = await llm.analyze(userPrompt, systemPrompt);
  const parsedResponse = parseAnalysisResponse(result.text);
  if (!parsedResponse.parsedJson) {
    logWarn('llm.analysis.parse_fallback', {
      chatId,
      entryId,
      threadId,
      provider: llm.providerName,
      model: llm.modelName,
      outputChars: result.text.length,
    });
  }

  const metrics = saveAnalysis(entryId, parsedResponse, llm);
  const dailyMemorySaved = saveDailyMemorySummary(entryDate, entryId, parsedResponse.parsed, llm);

  // Save analysis as assistant message in thread
  const freeform = parsedResponse.freeform;
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
  logInfo('llm.analysis.complete', {
    chatId,
    entryId,
    threadId,
    replyToMessageId,
    provider: llm.providerName,
    model: llm.modelName,
    elapsedMs: Date.now() - start,
    outputChars: freeform.length,
    parsedJson: parsedResponse.parsedJson,
    wantsAudioReply: parsedResponse.wantsAudioReply,
    metricsExtracted: Object.keys(metrics).length,
    dailyMemorySaved,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    costUsd: result.usage?.costUsd?.toFixed(5),
  });

  if (parsedResponse.wantsAudioReply) {
    await sendAudioReply(api, chatId, freeform, replyToMessageId).catch(async (err) => {
      logError('tts.reply.failed', err, { chatId, entryId, threadId, replyToMessageId });
      await sendRawHtmlMessages(api, chatId, t().audioReplyUnavailable, replyToMessageId).catch(() => {});
    });
  }
  return metrics;
}

async function analyzeCompare(
  api: Api,
  chatId: number,
  entryId: number,
  entryDate: string,
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
  let audioSent = false;

  for (let i = 0; i < results.length; i++) {
    const settled = results[i];
    const provider = providers[i];
    const label = `${provider.providerName} (${provider.modelName})`;

    if (settled.status === 'fulfilled') {
      const { result, llm, elapsed } = settled.value;
      const parsedResponse = parseAnalysisResponse(result.text);
      if (!parsedResponse.parsedJson) {
        logWarn('llm.analysis.compare_parse_fallback', {
          chatId,
          entryId,
          threadId,
          provider: llm.providerName,
          model: llm.modelName,
          outputChars: result.text.length,
        });
      }
      const metrics = saveAnalysis(entryId, parsedResponse, llm);

      if (!threadSaved) {
        firstMetrics = metrics;
      }

      const freeform = parsedResponse.freeform;

      // Save first successful provider's response as thread context for follow-up chat
      if (!threadSaved) {
        const dailyMemorySaved = saveDailyMemorySummary(entryDate, entryId, parsedResponse.parsed, llm);
        queries.insertThreadMessage({
          thread_id: threadId,
          role: 'assistant',
          content: freeform,
          llm_provider: llm.providerName,
          llm_model: llm.modelName,
        });
        threadSaved = true;
        logInfo('daily_memory.compare_saved', {
          entryId,
          threadId,
          provider: llm.providerName,
          model: llm.modelName,
          saved: dailyMemorySaved,
        });
      }
      const meta = `<blockquote>${label} | ${elapsed}s${formatUsage(result.usage)}</blockquote>`;
      const body = markdownToHtml(freeform);
      const metricsLine = formatMetricsLine(metrics);
      await sendRawHtmlMessages(api, chatId, `${meta}\n\n${body}${metricsLine}`, replyToMessageId);
      logInfo('llm.analysis.compare_complete', {
        chatId,
        entryId,
        threadId,
        replyToMessageId,
        provider: llm.providerName,
        model: llm.modelName,
        elapsedSec: elapsed,
        outputChars: freeform.length,
        parsedJson: parsedResponse.parsedJson,
        wantsAudioReply: parsedResponse.wantsAudioReply,
        metricsExtracted: Object.keys(metrics).length,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        costUsd: result.usage?.costUsd?.toFixed(5),
      });

      if (parsedResponse.wantsAudioReply && !audioSent) {
        await sendAudioReply(api, chatId, freeform, replyToMessageId).catch(async (err) => {
          logError('tts.reply.failed', err, { chatId, entryId, threadId, replyToMessageId });
          await sendRawHtmlMessages(api, chatId, t().audioReplyUnavailable, replyToMessageId).catch(() => {});
        });
        audioSent = true;
      }
    } else {
      const errMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      logError('llm.analysis.compare_failed', settled.reason, {
        chatId,
        entryId,
        threadId,
        replyToMessageId,
        provider: provider.providerName,
        model: provider.modelName,
      });
      await sendRawHtmlMessages(api, chatId, `<blockquote>${label}</blockquote>\n\nError: ${errMsg}`, replyToMessageId);
    }
  }

  return firstMetrics;
}
