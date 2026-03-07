import { config } from './config.js';
import { createBot } from './bot.js';
import { startScheduler } from './services/scheduler.js';
import { sendSplitMessages } from './utils/telegram.js';

function getAsrModel(): string {
  return config.asr.provider === 'elevenlabs' ? config.asr.elevenlabsModel : config.asr.openaiModel;
}

function getLlmModel(): string {
  return config.llm.provider === 'claude' ? config.llm.claudeModel : config.llm.openaiModel;
}

async function checkElevenLabsQuota(): Promise<string> {
  if (!config.keys.elevenlabs) return 'ElevenLabs: no key';
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': config.keys.elevenlabs },
    });
    if (!res.ok) return `ElevenLabs: ${res.status}`;
    const data = await res.json() as { character_count?: number; character_limit?: number; tier?: string };
    const used = data.character_count ?? 0;
    const limit = data.character_limit ?? 0;
    const remaining = limit - used;
    return `ElevenLabs: ${remaining.toLocaleString()}/${limit.toLocaleString()} chars (${data.tier})`;
  } catch {
    return 'ElevenLabs: check failed';
  }
}

async function checkOpenAIKey(): Promise<string> {
  if (!config.keys.openai) return 'OpenAI: no key';
  try {
    const res = await fetch('https://api.openai.com/v1/models?limit=1', {
      headers: { Authorization: `Bearer ${config.keys.openai}` },
    });
    return res.ok ? 'OpenAI: key valid' : `OpenAI: ${res.status}`;
  } catch {
    return 'OpenAI: check failed';
  }
}

async function checkAnthropicKey(): Promise<string> {
  if (!config.keys.anthropic) return 'Anthropic: no key';
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': config.keys.anthropic, 'anthropic-version': '2023-06-01' },
    });
    return res.ok ? 'Anthropic: key valid' : `Anthropic: ${res.status}`;
  } catch {
    return 'Anthropic: check failed';
  }
}

async function main() {
  console.log('CBT Bot starting...');
  console.log(`  Language: ${config.language}`);
  console.log(`  ASR: ${config.asr.provider} (${getAsrModel()})`);
  console.log(`  LLM: ${config.llm.provider} (${getLlmModel()})`);

  const bot = createBot();

  const me = await bot.api.getMe();
  console.log(`  Bot: @${me.username} (${me.id})`);

  // Check API keys in parallel
  const [elevenLabs, openai, anthropic] = await Promise.all([
    checkElevenLabsQuota(),
    checkOpenAIKey(),
    checkAnthropicKey(),
  ]);

  startScheduler(bot.api);

  // Startup message goes to discussion group
  const chatId = config.telegram.discussionGroupId || config.telegram.channelId;

  bot.start({
    onStart: async () => {
      console.log('Bot is running! Send a voice message to the channel.');

      if (chatId) {
        const lines = [
          '🟢 Bot started',
          '',
          `ASR: ${config.asr.provider} (${getAsrModel()})`,
          `LLM: ${config.llm.provider} (${getLlmModel()})`,
          config.compareMode
            ? `Compare: ON (claude/${config.llm.claudeModel} + openai/${config.llm.openaiModel})`
            : 'Compare: OFF',
          `Language: ${config.language}`,
          '',
          elevenLabs,
          openai,
          anthropic,
          '',
          '#bot',
        ];
        await sendSplitMessages(bot.api, chatId, lines.join('\n')).catch(() => {});
      }
    },
  });

  const shutdown = () => {
    console.log('Shutting down...');
    bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
