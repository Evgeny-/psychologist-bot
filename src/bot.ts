import { Bot, InputFile, type Context } from 'grammy';
import { config } from './config.js';
import { t } from './i18n/index.js';
import { queries } from './db/index.js';
import { transcribeVoiceMessage } from './services/transcription.js';
import { analyzeEntry } from './services/analysis.js';
import { handleThreadReply } from './services/chat.js';
import { generateTestWeeklyReport, generateTestMonthlyReport, generateTestMorningBrief, generateMemory } from './services/reports.js';
import { generateRecentDailyMemory, showRecentDailyMemory } from './services/daily-memory.js';
import { MEMORY_MAX_LENGTH } from './prompts/memory.js';
import { todayLocal, nowLocalTime, formatDateLocal } from './utils/date.js';
import { sendSplitMessages, sendRawHtmlMessages, notifyChannelPostForwarded, postChannelHeader, escapeHtml } from './utils/telegram.js';
import { decodeCallback, answeredLine } from './utils/callbacks.js';
import { ApiBalanceError } from './providers/asr/elevenlabs.js';
import { ApiBalanceError as LLMBalanceError } from './providers/llm/claude.js';
import { logError, logInfo, logWarn } from './utils/logger.js';


export function createBot(): Bot {
  const bot = new Bot(config.telegram.botToken);

  /**
   * Answers to the bot's one-question messages.
   *
   * Every ask lives in the discussion group, never in a channel post: an inline keyboard on a
   * channel post removes the "Comments" button and takes the whole thread with it.
   */
  bot.on('callback_query:data', async (ctx) => {
    const payload = decodeCallback(ctx.callbackQuery.data);
    if (!payload) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }

    const fromId = ctx.from?.id;
    if (config.telegram.ownerUserId && fromId !== config.telegram.ownerUserId) {
      logWarn('bot.callback.foreign_user', { fromId, data: ctx.callbackQuery.data });
      await ctx.answerCallbackQuery({ text: 'Это не твоя кнопка' }).catch(() => {});
      return;
    }

    try {
      let toast = 'Записал';
      if (payload.kind === 'lbl') {
        const verdict = payload.value as 'yes' | 'no' | 'partly';
        queries.reviewLabel(Number(payload.ref), verdict);
        toast = verdict === 'no' ? 'Снято' : 'Записал';
      } else if (payload.kind === 'ctr') {
        queries.resolveContract(payload.ref, { status: payload.value as 'done' | 'missed' });
      } else if (payload.kind === 'cred') {
        queries.answerMorningCredit(payload.ref, payload.value as 'yes' | 'no' | 'unsure');
      }

      logInfo('bot.callback.answered', { kind: payload.kind, ref: payload.ref, value: payload.value, fromId });
      await ctx.answerCallbackQuery({ text: toast }).catch(() => {});

      // Rewrite the message so the record shows what was answered; without this the buttons stay
      // tappable and the history says nothing about which question they belonged to.
      //
      // The original text is re-sent with its original entities rather than re-parsed as HTML:
      // `message.text` comes back with the markup stripped, so a round-trip through the parser
      // would flatten the quote the question was built around. Entity offsets are UTF-16 code
      // units, which is what String#length counts, so appending leaves every offset valid.
      const message = ctx.callbackQuery.message;
      const original = message && 'text' in message ? message.text ?? '' : '';
      const entities = message && 'entities' in message ? message.entities ?? [] : [];
      const suffix = answeredLine(payload.value, nowLocalTime());
      const updated = original ? `${original}\n\n${suffix}` : suffix;
      await ctx.editMessageText(updated, {
        entities: [...entities, { type: 'italic' as const, offset: updated.length - suffix.length, length: suffix.length }],
        reply_markup: undefined,
      }).catch((err) => logWarn('bot.callback.edit_failed', { error: err }));
    } catch (err) {
      logError('bot.callback.failed', err, { data: ctx.callbackQuery.data });
      await ctx.answerCallbackQuery({ text: 'Не получилось записать' }).catch(() => {});
    }
  });

  // Commands in channel posts
  bot.on('channel_post:text', async (ctx) => {
    const text = ctx.channelPost.text;
    const chatId = ctx.chat.id;

    if (text === '/weekly' || text.startsWith('/weekly@')) {
      logInfo('bot.channel_command', { command: '/weekly', chatId, messageId: ctx.channelPost.message_id });
      generateTestWeeklyReport(ctx.api, chatId).catch(err => logError('bot.command.weekly_failed', err, { chatId }));
      return;
    }

    if (text === '/monthly' || text.startsWith('/monthly@')) {
      logInfo('bot.channel_command', { command: '/monthly', chatId, messageId: ctx.channelPost.message_id });
      generateTestMonthlyReport(ctx.api, chatId).catch(err => logError('bot.command.monthly_failed', err, { chatId }));
      return;
    }

    if (text === '/morning' || text.startsWith('/morning@')) {
      logInfo('bot.channel_command', { command: '/morning', chatId, messageId: ctx.channelPost.message_id });
      generateTestMorningBrief(ctx.api, chatId).catch(err => logError('bot.command.morning_failed', err, { chatId }));
      return;
    }

    if (text === '/veto' || text.startsWith('/veto ') || text.startsWith('/veto@')) {
      logInfo('bot.channel_command', { command: '/veto', chatId, messageId: ctx.channelPost.message_id });
      handleVetoCommand(ctx.api, chatId, text).catch(err => logError('bot.command.veto_failed', err, { chatId }));
      return;
    }

    if (text === '/export' || text.startsWith('/export@')) {
      logInfo('bot.channel_command', { command: '/export', chatId, messageId: ctx.channelPost.message_id });
      handleExportCommand(ctx.api, chatId).catch(err => logError('bot.command.export_failed', err, { chatId }));
      return;
    }

    if (text === '/memory' || text.startsWith('/memory@')) {
      logInfo('bot.channel_command', { command: '/memory', chatId, messageId: ctx.channelPost.message_id });
      handleMemoryCommand(ctx.api, chatId).catch(err => logError('bot.command.memory_failed', err, { chatId }));
      return;
    }

    if (text === '/recentmemory' || text.startsWith('/recentmemory@')) {
      logInfo('bot.channel_command', { command: '/recentmemory', chatId, messageId: ctx.channelPost.message_id });
      showRecentDailyMemory(ctx.api, chatId).catch(err => logError('bot.command.recent_memory_failed', err, { chatId }));
      return;
    }

    if (text.startsWith('/setmemory ') || text.startsWith('/setmemory@')) {
      logInfo('bot.channel_command', { command: '/setmemory', chatId, messageId: ctx.channelPost.message_id });
      const content = text.replace(/^\/setmemory(@\S+)?\s+/, '').trim();
      if (!content) {
        ctx.api.sendMessage(chatId, config.language === 'ru'
          ? 'Использование: /setmemory <текст>\n\n#bot'
          : 'Usage: /setmemory <text>\n\n#bot').catch(() => {});
        return;
      }
      const trimmed = content.slice(0, MEMORY_MAX_LENGTH);
      queries.setMemory(trimmed);
      ctx.api.sendMessage(chatId, `<blockquote>🧠 Memory set (${trimmed.length}/${MEMORY_MAX_LENGTH})</blockquote>\n\n#bot`, { parse_mode: 'HTML' }).catch(() => {});
      return;
    }

    if (text === '/generatememory' || text.startsWith('/generatememory@')) {
      logInfo('bot.channel_command', { command: '/generatememory', chatId, messageId: ctx.channelPost.message_id });
      generateMemory(ctx.api, chatId).catch(err => logError('bot.command.generate_memory_failed', err, { chatId }));
      return;
    }

    if (text === '/generaterecentmemory' || text.startsWith('/generaterecentmemory@')) {
      logInfo('bot.channel_command', { command: '/generaterecentmemory', chatId, messageId: ctx.channelPost.message_id });
      generateRecentDailyMemory(ctx.api, chatId).catch(err => logError('bot.command.generate_recent_memory_failed', err, { chatId }));
      return;
    }

    logInfo('bot.channel_post', {
      chatId,
      messageId: ctx.channelPost.message_id,
      textChars: text?.length ?? 0,
    });
  });

  // Log non-text channel posts
  bot.on('channel_post', async (ctx) => {
    logInfo('bot.channel_post_non_text', {
      chatId: ctx.chat.id,
      messageId: ctx.channelPost.message_id,
    });
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
  logInfo('bot.message.received', {
    chatId: ctx.chat?.id,
    messageId: msg.message_id,
    threadId: msg.message_thread_id,
    isForwarded: !!msg.forward_origin,
    hasVoice: !!msg.voice,
    hasAudio: !!msg.audio,
    textChars: (msg.text || msg.caption || '').length,
  });

  // Register forwarded channel posts for the channel-to-comments pattern
  if (msg.forward_origin && 'message_id' in msg.forward_origin) {
    notifyChannelPostForwarded(
      (msg.forward_origin as { message_id: number }).message_id,
      msg.message_id,
    );
  }

  // Skip forwarded bot-generated posts (tagged with #bot) and commands
  if (msg.forward_origin) {
    const text = msg.text || msg.caption || '';
    if (text.startsWith('/') || text.includes('#bot')) {
      logInfo('bot.message.ignored_forwarded_bot_or_command', {
        chatId: ctx.chat?.id,
        messageId: msg.message_id,
      });
      return;
    }
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
  logInfo('bot.thread_message.start', {
    chatId: ctx.chat?.id,
    messageId: msg.message_id,
    threadId,
    hasVoice: !!voice,
    hasAudio: !!audio,
    textChars: text.length,
  });

  if (voice || audio) {
    const fileId = (voice || audio)!.file_id;
    const duration = (voice || audio)!.duration;

    const statusMsg = await ctx.reply(t().processingVoice, {
      reply_to_message_id: msg.message_id,
    });
    try {
      const { transcript } = await transcribeVoiceMessage(
        ctx.api,
        ctx.chat!.id,
        fileId,
        duration ?? 0,
        msg.message_id,
      );

      text = transcript;
    } finally {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
    }
    logInfo('bot.thread_message.transcribed', {
      chatId: ctx.chat?.id,
      messageId: msg.message_id,
      threadId,
      transcriptChars: text.length,
    });
  }

  if (!text.trim()) {
    logWarn('bot.thread_message.empty', {
      chatId: ctx.chat?.id,
      messageId: msg.message_id,
      threadId,
    });
    return;
  }

  await handleThreadReply(ctx.api, ctx.chat!.id, threadId, text, msg.message_id);
  logInfo('bot.thread_message.complete', {
    chatId: ctx.chat?.id,
    messageId: msg.message_id,
    threadId,
    textChars: text.length,
  });
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
  logInfo('bot.new_entry.start', {
    chatId: ctx.chat?.id,
    messageId: msg.message_id,
    isForwarded,
    entryType,
    hasVoice: !!voice,
    hasAudio: !!audio,
    textChars: text?.length ?? 0,
    durationSeconds: duration,
  });

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
  logInfo('bot.new_entry.saved', {
    entryId,
    chatId: ctx.chat?.id,
    messageId: msg.message_id,
    replyToId,
    channelPostId,
    entryType,
    date: today,
  });

  let contentForAnalysis: string;

  if (fileId) {
    const statusMsg = await ctx.reply(t().processingVoice, {
      reply_to_message_id: replyToId,
    });
    try {
      const { transcript } = await transcribeVoiceMessage(
        ctx.api,
        ctx.chat!.id,
        fileId,
        duration ?? 0,
        replyToId,
      );

      queries.updateEntryTranscript(entryId, transcript);
      contentForAnalysis = transcript;
    } finally {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
    }
    logInfo('bot.new_entry.transcribed', {
      entryId,
      chatId: ctx.chat?.id,
      messageId: msg.message_id,
      transcriptChars: contentForAnalysis.length,
    });
  } else {
    contentForAnalysis = text!;
  }

  const metrics = await analyzeEntry(ctx.api, ctx.chat!.id, entryId, contentForAnalysis, replyToId, replyToId, today);
  logInfo('bot.new_entry.analysis_complete', {
    entryId,
    chatId: ctx.chat?.id,
    messageId: msg.message_id,
    analysisInputChars: contentForAnalysis.length,
    metricsExtracted: Object.keys(metrics).length,
  });

  const hasMetrics = metrics.mood !== undefined || metrics.anxiety !== undefined || metrics.stress !== undefined || metrics.productivity !== undefined || metrics.routine !== undefined;
  if (hasMetrics) {
    queries.insertMetrics({
      entry_id: entryId,
      date: today,
      mood: metrics.mood,
      anxiety: metrics.anxiety,
      stress: metrics.stress,
      productivity: metrics.productivity,
      routine: metrics.routine,
    });
    logInfo('bot.new_entry.metrics_saved', {
      entryId,
      date: today,
      mood: metrics.mood,
      anxiety: metrics.anxiety,
      stress: metrics.stress,
      productivity: metrics.productivity,
      routine: metrics.routine,
    });
  } else if (!queries.hasMetricsForDate(today)) {
    await ctx.reply(t().metricsAsk, { reply_to_message_id: replyToId });
    logInfo('bot.new_entry.metrics_prompted', { entryId, date: today, replyToId });
  }
}

/**
 * Standing "never raise this again" instructions.
 *
 * `/veto <текст>` records one, `/veto` lists them, `/veto -<id>` removes one. Every morning
 * prompt carries the list verbatim. Without it the generator rediscovers a rejected idea a few
 * weeks later, and each repeat says the refusal was never recorded.
 */
async function handleVetoCommand(api: import('grammy').Api, chatId: number, text: string): Promise<void> {
  const arg = text.replace(/^\/veto(@\S+)?/, '').trim();

  if (!arg) {
    const vetoes = queries.getVetoes();
    const body = vetoes.length === 0
      ? 'Пока ничего не запрещено.\n\n<code>/veto текст</code> — запретить, <code>/veto -3</code> — снять запрет.'
      : `<b>Никогда не поднимать</b>\n${vetoes.map((v) => `${v.id}. ${escapeHtml(v.text)}`).join('\n')}`;
    await sendRawHtmlMessages(api, chatId, body);
    return;
  }

  const removal = arg.match(/^-(\d+)$/);
  if (removal) {
    const id = Number(removal[1]);
    const removed = queries.deleteVeto(id);
    await sendRawHtmlMessages(api, chatId, removed ? `Снял запрет ${id}.` : `Запрета ${id} нет.`);
    logInfo('bot.veto.removed', { id, removed });
    return;
  }

  const id = queries.insertVeto(arg);
  await sendRawHtmlMessages(api, chatId, `Записал в чёрный список под номером ${id}. Больше не подниму.`);
  logInfo('bot.veto.added', { id });
}


async function handleMemoryCommand(api: import('grammy').Api, chatId: number): Promise<void> {
  const memory = queries.getMemory();
  if (!memory) {
    await api.sendMessage(chatId, config.language === 'ru' ? 'Память пуста.\n\n#bot' : 'Memory is empty.\n\n#bot');
    return;
  }

  const header = `🧠 Memory (${memory.length}/${MEMORY_MAX_LENGTH})\n\n#bot`;
  const target = await postChannelHeader(api, chatId, config.telegram.discussionGroupId, header);
  await sendRawHtmlMessages(api, target.chatId, memory, target.replyToMessageId);
}

async function handleExportCommand(api: import('grammy').Api, chatId: number): Promise<void> {
  const strings = t();
  const data = queries.getExportData();

  if (data.length === 0) {
    await sendSplitMessages(api, chatId, `${strings.exportEmpty}\n\n#bot`);
    return;
  }

  const csvHeader = 'date,local_time,type,mood,anxiety,stress,productivity,routine,text';
  const rows = data.map((r) => {
    const text = (r.text || '').replace(/"/g, '""').replace(/\n/g, ' ');
    return `${r.date},${r.local_time || ''},${r.type},${r.mood ?? ''},${r.anxiety ?? ''},${r.stress ?? ''},${r.productivity ?? ''},${r.routine ?? ''},"${text}"`;
  });

  const csv = [csvHeader, ...rows].join('\n');
  const buffer = Buffer.from(csv, 'utf-8');

  const target = await postChannelHeader(api, chatId, config.telegram.discussionGroupId, `📤 Export: ${data.length} entries\n\n#bot`);
  await api.sendDocument(target.chatId, new InputFile(buffer, 'cbt-export.csv'), {
    reply_to_message_id: target.replyToMessageId,
  });
}

async function handleError(ctx: Context, err: unknown): Promise<void> {
  logError('bot.error', err, {
    chatId: ctx.chat?.id,
    messageId: ctx.message?.message_id,
    threadId: ctx.message?.message_thread_id,
  });

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
