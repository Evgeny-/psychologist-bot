import 'dotenv/config';

export type ASRProviderType = 'elevenlabs' | 'openai';
export type LLMProviderType = 'claude' | 'openai';
export type BotLanguage = 'ru' | 'en';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    channelId: process.env.TELEGRAM_CHANNEL_ID ? Number(process.env.TELEGRAM_CHANNEL_ID) : undefined,
    discussionGroupId: process.env.TELEGRAM_DISCUSSION_GROUP_ID ? Number(process.env.TELEGRAM_DISCUSSION_GROUP_ID) : undefined,
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID ? Number(process.env.TELEGRAM_ADMIN_CHAT_ID) : undefined,
    ownerUserId: process.env.TELEGRAM_OWNER_USER_ID ? Number(process.env.TELEGRAM_OWNER_USER_ID) : undefined,
  },

  asr: {
    provider: (process.env.ASR_PROVIDER || 'elevenlabs') as ASRProviderType,
    openaiModel: process.env.OPENAI_ASR_MODEL || 'gpt-4o-transcribe',
    elevenlabsModel: process.env.ELEVENLABS_ASR_MODEL || 'scribe_v2',
  },

  llm: {
    provider: (process.env.LLM_PROVIDER || 'claude') as LLMProviderType,
    openaiModel: process.env.OPENAI_LLM_MODEL || 'gpt-5.4',
    claudeModel: process.env.CLAUDE_LLM_MODEL || 'claude-sonnet-4-6',
  },

  compareMode: process.env.COMPARE_MODE === 'true',

  language: (process.env.BOT_LANGUAGE || 'ru') as BotLanguage,

  timezone: process.env.BOT_TIMEZONE || 'Europe/Moscow',

  keys: {
    openai: process.env.OPENAI_API_KEY || '',
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    elevenlabs: process.env.ELEVENLABS_API_KEY || '',
  },
} as const;
