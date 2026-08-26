import 'dotenv/config';

export type ASRProviderType = 'elevenlabs' | 'openai';
export type LLMProviderType = 'claude' | 'openai';
export type TTSProviderType = 'elevenlabs' | 'openai';
/**
 * The hour from which an entry counts as summing the day up.
 *
 * Two things hang off it and must not drift apart: the evening reminder skips days that already
 * have an entry from this hour on, and the daily prompt refuses to infer metrics from a word
 * description written before it. An entry that closes the day for one and not the other would be
 * incoherent, so both read this constant — the prompt interpolates it rather than restating it.
 */
export const EVENING_FROM_HOUR = 15;

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
    openaiModel: process.env.OPENAI_LLM_MODEL || 'gpt-5.4-mini',
    claudeModel: process.env.CLAUDE_LLM_MODEL || 'claude-sonnet-4-6',
    // How hard the OpenAI reasoning models think per reply (minimal|low|medium|high).
    reasoningEffort: (process.env.LLM_REASONING_EFFORT || 'low') as 'minimal' | 'low' | 'medium' | 'high',
  },

  tts: {
    provider: (process.env.TTS_PROVIDER || 'elevenlabs') as TTSProviderType,
    openaiModel: process.env.OPENAI_TTS_MODEL || 'tts-1',
    openaiVoice: process.env.OPENAI_TTS_VOICE || 'shimmer',
    openaiSpeed: process.env.OPENAI_TTS_SPEED ? Number(process.env.OPENAI_TTS_SPEED) : 1.1,
    elevenlabsModel: process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5',
    elevenlabsVoiceId: process.env.ELEVENLABS_TTS_VOICE_ID || '',
    elevenlabsSpeed: process.env.ELEVENLABS_TTS_SPEED ? Number(process.env.ELEVENLABS_TTS_SPEED) : 1.1,
  },

  compareMode: process.env.COMPARE_MODE === 'true',

  language: (process.env.BOT_LANGUAGE || 'ru') as BotLanguage,
  // Used only to address the user by name in the say-instead line. Self-distancing works better
  // with a name than with "you", and the name never enters the repository — only the server .env.
  userName: process.env.BOT_USER_NAME || '',

  timezone: process.env.BOT_TIMEZONE || 'Europe/Moscow',

  keys: {
    openai: process.env.OPENAI_API_KEY || '',
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    elevenlabs: process.env.ELEVENLABS_API_KEY || '',
  },
} as const;
