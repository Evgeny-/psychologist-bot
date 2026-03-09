import { Bot, InputFile, type Context } from 'grammy';
import { config } from './config.js';
import { t } from './i18n/index.js';
import { queries } from './db/index.js';
import { transcribeVoiceMessage } from './services/transcription.js';
import { analyzeEntry } from './services/analysis.js';
import { handleThreadReply } from './services/chat.js';
import { generateTestWeeklyReport, generateTestMonthlyReport, generateMemory } from './services/reports.js';
import { MEMORY_MAX_LENGTH } from './prompts/memory.js';
import { todayLocal, nowLocalTime, formatDateLocal } from './utils/date.js';
import { sendSplitMessages } from './utils/telegram.js';
import { ApiBalanceError } from './providers/asr/elevenlabs.js';
import { ApiBalanceError as LLMBalanceError } from './providers/llm/claude.js';


export function createBot(): Bot {
  const bot = new Bot(config.telegram.botToken);

  // Commands in channel posts
  bot.on('channel_post:text', async (ctx) => {
    const text = ctx.channelPost.text;
    const chatId = ctx.chat.id;

    if (text === '/weekly' || text.startsWith('/weekly@')) {
      try {
        console.log('Channel command: /weekly');
        await generateTestWeeklyReport(ctx.api, chatId);
      } catch (err) {
        console.error('Weekly report error:', err);
      }
      return;
    }

    if (text === '/monthly' || text.startsWith('/monthly@')) {
      try {
        console.log('Channel command: /monthly');
        await generateTestMonthlyReport(ctx.api, chatId);
      } catch (err) {
        console.error('Monthly report error:', err);
      }
      return;
    }

    if (text === '/stats' || text.startsWith('/stats@')) {
      try {
        console.log('Channel command: /stats');
        await handleStatsCommand(ctx.api, chatId);
      } catch (err) {
        console.error('Stats error:', err);
      }
      return;
    }

    if (text === '/export' || text.startsWith('/export@')) {
      try {
        console.log('Channel command: /export');
        await handleExportCommand(ctx.api, chatId);
      } catch (err) {
        console.error('Export error:', err);
      }
      return;
    }

    if (text === '/memory' || text.startsWith('/memory@')) {
      try {
        console.log('Channel command: /memory');
        const memory = queries.getMemory();
        const msg = memory
          ? `<blockquote>🧠 Memory (${memory.length}/${MEMORY_MAX_LENGTH})</blockquote>\n\n${memory}\n\n#bot`
          : (config.language === 'ru' ? 'Память пуста.\n\n#bot' : 'Memory is empty.\n\n#bot');
        await ctx.api.sendMessage(chatId, msg, { parse_mode: 'HTML' });
      } catch (err) {
        console.error('Memory error:', err);
      }
      return;
    }

    if (text.startsWith('/setmemory ') || text.startsWith('/setmemory@')) {
      try {
        console.log('Channel command: /setmemory');
        const content = text.replace(/^\/setmemory(@\S+)?\s+/, '').trim();
        if (!content) {
          await ctx.api.sendMessage(chatId, config.language === 'ru'
            ? 'Использование: /setmemory <текст>\n\n#bot'
            : 'Usage: /setmemory <text>\n\n#bot');
          return;
        }
        const trimmed = content.slice(0, MEMORY_MAX_LENGTH);
        queries.setMemory(trimmed);
        await ctx.api.sendMessage(chatId, `<blockquote>🧠 Memory set (${trimmed.length}/${MEMORY_MAX_LENGTH})</blockquote>\n\n#bot`, { parse_mode: 'HTML' });
      } catch (err) {
        console.error('Set memory error:', err);
      }
      return;
    }

    if (text === '/generatememory' || text.startsWith('/generatememory@')) {
      try {
        console.log('Channel command: /generatememory');
        await generateMemory(ctx.api, chatId);
      } catch (err) {
        console.error('Generate memory error:', err);
      }
      return;
    }

    console.log(`Channel post in chat ${chatId}, message ${ctx.channelPost.message_id}`);
  });

  // Log non-text channel posts
  bot.on('channel_post', async (ctx) => {
    console.log(`Channel post in chat ${ctx.chat.id}, message ${ctx.channelPost.message_id}`);
  });

  // Discussion group messages — diary entries + thread conversations
  bot.on('message', async (ctx) => {
    // Only process messages in the configured discussion group (private, so all members are trusted)
    if (config.telegram.discussionGroupId && ctx.chat.id !== config.telegram.discussionGroupId) {
      return;
    }

    try {
      await handleMessage(ctx);
    } catch (err) {
      await handleError(ctx, err);
    }
  });

  return bot;
}

async function handleMessage(ctx: Context): Promise<void> {
  const msg = ctx.message;
  if (!msg) return;

  // Skip forwarded bot-generated posts (tagged with #bot) and commands
  if (msg.forward_origin) {
    const text = msg.text || msg.caption || '';
    if (text.startsWith('/') || text.includes('#bot')) return;
  }

  const isForwarded = !!msg.forward_origin;
  const threadId = msg.message_thread_id;

  // Thread reply (not a forwarded channel post) → continue conversation
  if (threadId && !isForwarded) {
    await handleThreadMessage(ctx, threadId);
    return;
  }

  // New entry (forwarded from channel or direct message)
  await handleNewEntry(ctx);
}

async function handleThreadMessage(ctx: Context, threadId: number): Promise<void> {
  const msg = ctx.message!;
  const voice = msg.voice;
  const audio = msg.audio;
  let text = msg.text || msg.caption || '';

  if (voice || audio) {
    const fileId = (voice || audio)!.file_id;
    const duration = (voice || audio)!.duration;

    const statusMsg = await ctx.reply(t().processingVoice, {
      reply_to_message_id: msg.message_id,
    });

    const { transcript } = await transcribeVoiceMessage(
      ctx.api,
      ctx.chat!.id,
      fileId,
      duration ?? 0,
      msg.message_id,
    );

    text = transcript;
    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
  }

  if (!text.trim()) return;

  await handleThreadReply(ctx.api, ctx.chat!.id, threadId, text, msg.message_id);
}

async function handleNewEntry(ctx: Context): Promise<void> {
  const msg = ctx.message!;
  const isForwarded = !!msg.forward_origin;
  const voice = msg.voice;
  const audio = msg.audio;
  const text = msg.text || msg.caption;

  let entryType: string;
  let fileId: string | undefined;
  let duration: number | undefined;

  if (voice) {
    entryType = isForwarded ? 'forwarded_voice' : 'voice';
    fileId = voice.file_id;
    duration = voice.duration;
  } else if (audio) {
    entryType = isForwarded ? 'forwarded_voice' : 'voice';
    fileId = audio.file_id;
    duration = audio.duration;
  } else if (text) {
    entryType = isForwarded ? 'forwarded_text' : 'text';
  } else {
    return;
  }

  const today = todayLocal();
  const forwardOrigin = msg.forward_origin;
  const channelPostId = forwardOrigin && 'message_id' in forwardOrigin ? forwardOrigin.message_id : undefined;

  const entryId = queries.insertEntry({
    telegram_message_id: msg.message_id,
    channel_post_id: channelPostId,
    date: today,
    type: entryType,
    raw_text: text,
    duration_seconds: duration,
    local_time: nowLocalTime(),
  });

  const replyToId = msg.message_thread_id ?? msg.message_id;

  let contentForAnalysis: string;

  if (fileId) {
    const statusMsg = await ctx.reply(t().processingVoice, {
      reply_to_message_id: replyToId,
    });

    const { transcript } = await transcribeVoiceMessage(
      ctx.api,
      ctx.chat!.id,
      fileId,
      duration ?? 0,
      replyToId,
    );

    queries.updateEntryTranscript(entryId, transcript);
    contentForAnalysis = transcript;

    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
  } else {
    contentForAnalysis = text!;
  }

  const metrics = await analyzeEntry(ctx.api, ctx.chat!.id, entryId, contentForAnalysis, replyToId, replyToId, today);

  const hasMetrics = metrics.mood !== undefined || metrics.anxiety !== undefined || metrics.self_esteem !== undefined || metrics.productivity !== undefined;
  if (hasMetrics) {
    queries.insertMetrics({
      entry_id: entryId,
      date: today,
      mood: metrics.mood,
      anxiety: metrics.anxiety,
      self_esteem: metrics.self_esteem,
      productivity: metrics.productivity,
    });
  } else if (!queries.hasMetricsForDate(today)) {
    await ctx.reply(t().metricsAsk, { reply_to_message_id: replyToId });
  }
}

async function handleStatsCommand(api: import('grammy').Api, chatId: number): Promise<void> {
  const strings = t();
  const today = todayLocal();
  const streak = queries.getStreak(today);
  const total = queries.getTotalEntries();

  // Last 7 days metrics
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 6);
  const startStr = formatDateLocal(weekAgo);
  const avg = queries.getAverageMetrics(startStr, today);

  const lines: string[] = [
    `<b>${strings.statsHeader}</b>`,
    '',
    strings.statsStreak.replace('{streak}', String(streak)),
    strings.statsTotalEntries.replace('{total}', String(total)),
  ];

  if (avg.count > 0) {
    lines.push('');
    lines.push(strings.statsMetricsForDays.replace('{days}', '7'));
    if (avg.avgMood !== null) lines.push(strings.statsAvgMood.replace('{value}', avg.avgMood.toFixed(1)));
    if (avg.avgAnxiety !== null) lines.push(strings.statsAvgAnxiety.replace('{value}', avg.avgAnxiety.toFixed(1)));
    if (avg.avgSelfEsteem !== null) lines.push(strings.statsAvgSelfEsteem.replace('{value}', avg.avgSelfEsteem.toFixed(1)));
    if (avg.avgProductivity !== null) lines.push(strings.statsAvgProductivity.replace('{value}', avg.avgProductivity.toFixed(1)));
  } else {
    lines.push('');
    lines.push(strings.statsNoMetrics);
  }

  // Last 7 days per-day metrics chart
  const metrics = queries.getMetricsByDateRange(startStr, today);
  if (metrics.length > 0) {
    lines.push('');
    for (const m of metrics) {
      const parts: string[] = [];
      if (m.mood !== null) parts.push(`M${m.mood}`);
      if (m.anxiety !== null) parts.push(`A${m.anxiety}`);
      if (m.self_esteem !== null) parts.push(`SE${m.self_esteem}`);
      if (m.productivity !== null) parts.push(`P${m.productivity}`);
      if (parts.length) lines.push(`${m.date}: ${parts.join(' ')}`);
    }
  }

  lines.push('');
  lines.push('#bot');

  await api.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

async function handleExportCommand(api: import('grammy').Api, chatId: number): Promise<void> {
  const strings = t();
  const data = queries.getExportData();

  if (data.length === 0) {
    await sendSplitMessages(api, chatId, `${strings.exportEmpty}\n\n#bot`);
    return;
  }

  const header = 'date,local_time,type,mood,anxiety,self_esteem,productivity,text';
  const rows = data.map((r) => {
    const text = (r.text || '').replace(/"/g, '""').replace(/\n/g, ' ');
    return `${r.date},${r.local_time || ''},${r.type},${r.mood ?? ''},${r.anxiety ?? ''},${r.self_esteem ?? ''},${r.productivity ?? ''},"${text}"`;
  });

  const csv = [header, ...rows].join('\n');
  const buffer = Buffer.from(csv, 'utf-8');

  await api.sendDocument(chatId, new InputFile(buffer, 'cbt-export.csv'), {
    caption: `Export: ${data.length} entries\n\n#bot`,
  });
}

async function handleError(ctx: Context, err: unknown): Promise<void> {
  console.error('Bot error:', err);

  const strings = t();

  if (err instanceof ApiBalanceError || err instanceof LLMBalanceError) {
    await ctx.reply(strings.errorApiBalance).catch(() => {});

    if (config.telegram.adminChatId) {
      const detail = err instanceof Error ? err.message : String(err);
      await ctx.api.sendMessage(
        config.telegram.adminChatId,
        strings.errorApiGeneric
          .replace('{provider}', detail.split(':')[0] || 'unknown')
          .replace('{message}', detail),
      ).catch(() => {});
    }
  } else {
    await ctx.reply(strings.errorGeneric).catch(() => {});

    if (config.telegram.adminChatId && err instanceof Error) {
      await ctx.api.sendMessage(
        config.telegram.adminChatId,
        `Error: ${err.message}\n\n${err.stack?.slice(0, 500)}`,
      ).catch(() => {});
    }
  }
}
