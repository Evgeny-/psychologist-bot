import { config, type LLMProviderType } from '../../config.js';
import { ClaudeLLM } from './claude.js';
import { OpenAILLM } from './openai.js';
import { logWarn } from '../../utils/logger.js';

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  costUsd: number;
}

export interface LLMResult {
  text: string;
  usage?: LLMUsage;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMProvider {
  analyze(userPrompt: string, systemPrompt: string): Promise<LLMResult>;
  chat(messages: ChatMessage[], systemPrompt: string): Promise<LLMResult>;
  readonly providerName: string;
  readonly modelName: string;
}

/**
 * Wraps a primary provider and falls back to a secondary one when the primary
 * fails (provider outage, quota/permission errors, transient failures that
 * survived retries). Keeps the primary's identity so logs/metrics stay stable;
 * a fallback event is logged whenever the secondary is used.
 */
class FallbackLLM implements LLMProvider {
  readonly providerName: string;
  constructor(private primary: LLMProvider, private fallback: LLMProvider) {
    this.providerName = primary.providerName;
  }
  get modelName(): string {
    return this.primary.modelName;
  }
  analyze(userPrompt: string, systemPrompt: string): Promise<LLMResult> {
    return this.run((p) => p.analyze(userPrompt, systemPrompt));
  }
  chat(messages: ChatMessage[], systemPrompt: string): Promise<LLMResult> {
    return this.run((p) => p.chat(messages, systemPrompt));
  }
  private async run(call: (p: LLMProvider) => Promise<LLMResult>): Promise<LLMResult> {
    try {
      return await call(this.primary);
    } catch (err) {
      logWarn('llm.fallback.triggered', {
        primary: `${this.primary.providerName}/${this.primary.modelName}`,
        fallback: `${this.fallback.providerName}/${this.fallback.modelName}`,
        reason: err instanceof Error ? err.message : String(err),
      });
      return await call(this.fallback);
    }
  }
}

function buildProvider(kind: LLMProviderType): LLMProvider | null {
  if (kind === 'claude') {
    return config.keys.anthropic ? new ClaudeLLM(config.keys.anthropic, config.llm.claudeModel) : null;
  }
  if (kind === 'openai') {
    return config.keys.openai ? new OpenAILLM(config.keys.openai, config.llm.openaiModel, config.llm.reasoningEffort) : null;
  }
  return null;
}

export function createLLMProvider(): LLMProvider {
  const primary = buildProvider(config.llm.provider);
  if (!primary) throw new Error(`LLM provider ${config.llm.provider} has no API key configured`);

  // If the other provider is also configured, use it as an automatic fallback so a
  // single-provider outage (quota, model-access, transient) doesn't drop the analysis.
  const otherKind: LLMProviderType = config.llm.provider === 'openai' ? 'claude' : 'openai';
  const fallback = buildProvider(otherKind);
  return fallback ? new FallbackLLM(primary, fallback) : primary;
}

export function createAllLLMProviders(): LLMProvider[] {
  const providers: LLMProvider[] = [];
  if (config.keys.anthropic) {
    providers.push(new ClaudeLLM(config.keys.anthropic, config.llm.claudeModel));
  }
  if (config.keys.openai) {
    providers.push(new OpenAILLM(config.keys.openai, config.llm.openaiModel, config.llm.reasoningEffort));
  }
  return providers;
}
