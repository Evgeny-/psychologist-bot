import { config } from '../../config.js';
import { ClaudeLLM } from './claude.js';
import { OpenAILLM } from './openai.js';

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
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

export function createLLMProvider(): LLMProvider {
  switch (config.llm.provider) {
    case 'claude':
      return new ClaudeLLM(config.keys.anthropic, config.llm.claudeModel);
    case 'openai':
      return new OpenAILLM(config.keys.openai, config.llm.openaiModel);
    default:
      throw new Error(`Unknown LLM provider: ${config.llm.provider}`);
  }
}

export function createAllLLMProviders(): LLMProvider[] {
  const providers: LLMProvider[] = [];
  if (config.keys.anthropic) {
    providers.push(new ClaudeLLM(config.keys.anthropic, config.llm.claudeModel));
  }
  if (config.keys.openai) {
    providers.push(new OpenAILLM(config.keys.openai, config.llm.openaiModel));
  }
  return providers;
}
