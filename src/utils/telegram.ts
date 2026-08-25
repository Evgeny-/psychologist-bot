import type { Api, InlineKeyboard } from 'grammy';
import { logInfo, logWarn } from './logger.js';
import { withRetry } from './retry.js';

const MAX_MESSAGE_LENGTH = 4096;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline spans, applied to already-escaped text. Code is pulled out first so its contents stay literal. */
function applyInline(escaped: string): string {
  const codeSpans: string[] = [];
  let out = escaped.replace(/`([^`]+)`/g, (_m, body: string) => {
    codeSpans.push(`<code>${body}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  out = out.replace(/~~(.+?)~~/g, '<s>$1</s>');
  // Italic: the asterisk must hug its content on both sides. Without that, multiplication signs
  // in ordinary prose ("5 * 8 часов, потом 2 * 3 подхода") get welded into one italic span.
  out = out.replace(/(^|[\s(])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=$|[\s.,;:!?)])/g, '$1<i>$2</i>');

  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codeSpans[Number(i)]);
}

/** A markdown table becomes a monospace block: Telegram has no tables, and raw pipes are unreadable on a phone. */
function renderTable(rows: string[]): string {
  const cells = rows
    .filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r))
    .map((r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()));
  if (cells.length === 0) return '';

  const cols = Math.max(...cells.map((c) => c.length));
  const plain = cells.map((row) =>
    Array.from({ length: cols }, (_, i) => (row[i] ?? '').replace(/\*\*|\*|`/g, '')),
  );
  // Narrow columns keep the block inside the screen; wider content wraps and defeats the point.
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.min(24, Math.max(...plain.map((r) => r[i].length))),
  );
  const lines = plain.map((row) =>
    row
      .map((c, i) => (c.length > widths[i] ? c.slice(0, widths[i] - 1) + '…' : c.padEnd(widths[i])))
      .join('  ')
      .trimEnd(),
  );
  return `<pre>${escapeHtml(lines.join('\n'))}</pre>`;
}

const BULLETS = ['•', '◦', '‣'];

/**
 * Markdown to Telegram HTML.
 *
 * Block-aware on purpose. The previous line-by-line version escaped `>` before anything could
 * recognise a quote, so every "say this exact sentence" line the model produced arrived as
 * ordinary prose — and a quote is the one device that makes a required phrase look required.
 */
export function markdownToHtml(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*-{3,}\s*$/.test(line) || /^\s*\*{3,}\s*$/.test(line)) {
      out.push('');
      i++;
      continue;
    }

    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre>${escapeHtml(body.join('\n'))}</pre>`);
      continue;
    }

    // A pipe row followed by a separator row is a table.
    if (/^\s*\|.*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      out.push(renderTable(rows));
      continue;
    }

    // Consecutive `>` lines collapse into one quote block.
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(applyInline(escapeHtml(lines[i].replace(/^\s*>\s?/, ''))));
        i++;
      }
      out.push(`<blockquote>${body.join('\n')}</blockquote>`);
      continue;
    }

    // Headings of any depth: the old regex stopped at ###, leaving #### as literal hashes.
    const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      out.push(`<b>${applyInline(escapeHtml(heading[1]))}</b>`);
      i++;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const depth = Math.min(Math.floor(bullet[1].length / 2), BULLETS.length - 1);
      out.push(`${'  '.repeat(depth)}${BULLETS[depth]} ${applyInline(escapeHtml(bullet[2]))}`);
      i++;
      continue;
    }
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ordered) {
      const depth = Math.min(Math.floor(ordered[1].length / 2), BULLETS.length - 1);
      out.push(`${'  '.repeat(depth)}${ordered[2]}. ${applyInline(escapeHtml(ordered[3]))}`);
      i++;
      continue;
    }

    out.push(applyInline(escapeHtml(line)));
    i++;
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['br', 'hr', 'img']);

interface Token {
  raw: string;
  /** Visible characters this token contributes; markup contributes nothing. */
  len: number;
  kind: 'open' | 'close' | 'text';
  name?: string;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) {
      const chunk = html.slice(last, m.index);
      tokens.push({ raw: chunk, len: chunk.length, kind: 'text' });
    }
    const name = m[1].toLowerCase();
    if (VOID_TAGS.has(name)) {
      tokens.push({ raw: m[0], len: 0, kind: 'text' });
    } else {
      tokens.push({ raw: m[0], len: 0, kind: m[0].startsWith('</') ? 'close' : 'open', name });
    }
    last = m.index + m[0].length;
  }
  if (last < html.length) {
    const chunk = html.slice(last);
    tokens.push({ raw: chunk, len: chunk.length, kind: 'text' });
  }
  return tokens;
}

function closeTagsFor(stack: Token[]): string {
  return stack.map((t) => `</${t.name}>`).reverse().join('');
}

/**
 * Split HTML into Telegram-sized messages without ever breaking a tag.
 *
 * Length is counted in visible characters, because Telegram measures the text and carries
 * entities separately; the old version counted markup too and cut messages short.
 * When a cut lands inside open tags they are closed at the end of the chunk and reopened at
 * the start of the next one. Without that a long quote block guarantees a 400 from the API,
 * and with no error handling above it the whole analysis was lost.
 */
export function splitMessage(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
  const tokens = tokenize(text);
  if (tokens.reduce((n, t) => n + t.len, 0) <= maxLen) return [text];

  const chunks: string[] = [];
  let buf: string[] = [];
  let visible = 0;
  const stack: Token[] = [];
  /** Position in `buf` just after the last clean break, and the visible length at that point. */
  let safeCut = -1;
  let safeVisible = 0;

  const flush = (upto?: number) => {
    const take = upto === undefined ? buf.length : upto;
    const body = buf.slice(0, take).join('') + closeTagsFor(stack);
    if (body.trim()) chunks.push(body);
    const reopened = stack.map((t) => t.raw).join('');
    const rest = buf.slice(take);
    buf = reopened ? [reopened, ...rest] : rest;
    visible = upto === undefined ? 0 : visible - safeVisible;
    safeCut = -1;
    safeVisible = 0;
  };

  for (const token of tokens) {
    if (token.kind === 'text' && visible + token.len > maxLen) {
      let room = maxLen - visible;
      let rest = token.raw;
      while (rest.length > room) {
        let cut = rest.lastIndexOf('\n', room);
        if (cut < room * 0.3) cut = rest.lastIndexOf(' ', room);
        if (cut < room * 0.3) cut = room;
        buf.push(rest.slice(0, cut));
        flush();
        rest = rest.slice(cut).replace(/^[ \t]+/, '');
        room = maxLen;
      }
      if (rest) {
        buf.push(rest);
        visible += rest.length;
      }
      continue;
    }

    if (visible + token.len > maxLen) flush(safeCut > 0 ? safeCut : undefined);

    buf.push(token.raw);
    visible += token.len;

    if (token.kind === 'open') {
      stack.push(token);
    } else if (token.kind === 'close') {
      const idx = stack.map((t) => t.name).lastIndexOf(token.name);
      if (idx >= 0) stack.splice(idx, 1);
      if (stack.length === 0) {
        safeCut = buf.length;
        safeVisible = visible;
      }
    } else if (stack.length === 0 && /\n\s*\n\s*$/.test(token.raw)) {
      safeCut = buf.length;
      safeVisible = visible;
    }
  }

  const tail = buf.join('') + closeTagsFor(stack);
  if (tail.trim()) chunks.push(tail);
  return chunks;
}

// Extract a trailing hashtag (e.g. #bot) and ensure it appears in every chunk
function splitWithTag(text: string, maxLen: number): string[] {
  const tagMatch = text.match(/\n\n(#\w+)\s*$/);
  if (!tagMatch) return splitMessage(text, maxLen);

  const tag = tagMatch[1];
  const body = text.slice(0, tagMatch.index!);
  const chunks = splitMessage(body, maxLen - tag.length - 2);
  return chunks.map((chunk) => `${chunk}\n\n${tag}`);
}

/** Strip markup so a chunk Telegram refused to parse can still be delivered as plain text. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export interface SendOptions {
  replyToMessageId?: number;
  /**
   * Attached to the LAST chunk only. Telegram renders a keyboard under the whole message, not
   * where it appears in the text, so a question and its buttons must end up in the same final
   * message — otherwise the buttons float below content they do not belong to.
   */
  keyboard?: InlineKeyboard;
}

async function sendChunks(
  api: Api,
  chatId: number,
  chunks: string[],
  options: SendOptions,
  logEvent: string,
  textChars: number,
): Promise<number[]> {
  const messageIds: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const extra = {
      reply_to_message_id: options.replyToMessageId,
      reply_markup: isLast ? options.keyboard : undefined,
    };
    try {
      const msg = await api.sendMessage(chatId, chunks[i], { parse_mode: 'HTML', ...extra });
      messageIds.push(msg.message_id);
    } catch (err) {
      // A malformed entity used to throw all the way out and take the entire analysis with it.
      // Delivering the text unformatted is strictly better than delivering nothing.
      logWarn('telegram.send.parse_failed', {
        chatId,
        chunkIndex: i,
        chunkChars: chunks[i].length,
        preview: chunks[i].slice(0, 200),
        error: err,
      });
      const msg = await api.sendMessage(chatId, stripTags(chunks[i]), extra);
      messageIds.push(msg.message_id);
    }
  }

  logInfo(logEvent, {
    chatId,
    replyToMessageId: options.replyToMessageId,
    chunks: chunks.length,
    firstMessageId: messageIds[0],
    lastMessageId: messageIds[messageIds.length - 1],
    hasKeyboard: !!options.keyboard,
    textChars,
  });

  return messageIds;
}

export async function sendSplitMessages(
  api: Api,
  chatId: number,
  text: string,
  replyToMessageId?: number,
  options: SendOptions = {},
): Promise<number[]> {
  const chunks = splitWithTag(markdownToHtml(text), MAX_MESSAGE_LENGTH);
  return sendChunks(api, chatId, chunks, { ...options, replyToMessageId }, 'telegram.send_split.complete', text.length);
}

export async function sendRawHtmlMessages(
  api: Api,
  chatId: number,
  html: string,
  replyToMessageId?: number,
  options: SendOptions = {},
): Promise<number[]> {
  const chunks = splitWithTag(html, MAX_MESSAGE_LENGTH);
  return sendChunks(api, chatId, chunks, { ...options, replyToMessageId }, 'telegram.send_html.complete', html.length);
}

// --- Channel-to-comments pattern ---
// When a bot posts to a channel with a linked discussion group, Telegram auto-forwards
// the message to the group. We capture that forwarded message ID to post replies as "comments".

const pendingForwards = new Map<number, (groupMsgId: number) => void>();

/** Call from the message handler when a forwarded channel post arrives in the group. */
export function notifyChannelPostForwarded(channelMsgId: number, groupMsgId: number): void {
  const resolve = pendingForwards.get(channelMsgId);
  if (resolve) {
    resolve(groupMsgId);
    pendingForwards.delete(channelMsgId);
  }
}

export interface CommentTarget {
  chatId: number;
  replyToMessageId?: number;
}

/**
 * Send a short header to the channel, then return where to post the full content as comments.
 * If discussionGroupId is set, waits for the auto-forwarded message and returns the group + thread ID.
 * Falls back to posting directly to the channel on timeout or if no group is configured.
 */
export async function postChannelHeader(
  api: Api,
  channelId: number,
  groupId: number | undefined,
  headerHtml: string,
): Promise<CommentTarget> {
  const channelMsg = await api.sendMessage(channelId, headerHtml, { parse_mode: 'HTML' });
  logInfo('telegram.channel_header.sent', {
    channelId,
    groupId,
    channelMessageId: channelMsg.message_id,
    headerChars: headerHtml.length,
  });

  if (!groupId) {
    return { chatId: channelId };
  }

  try {
    const groupMsgId = await new Promise<number>((resolve, reject) => {
      pendingForwards.set(channelMsg.message_id, resolve);
      setTimeout(() => {
        pendingForwards.delete(channelMsg.message_id);
        reject(new Error('Timeout'));
      }, 10000);
    });
    logInfo('telegram.channel_header.forwarded', {
      channelId,
      groupId,
      channelMessageId: channelMsg.message_id,
      groupMessageId: groupMsgId,
    });
    return { chatId: groupId, replyToMessageId: groupMsgId };
  } catch {
    logWarn('telegram.channel_header.forward_timeout', {
      channelId,
      groupId,
      channelMessageId: channelMsg.message_id,
    });
    return { chatId: channelId };
  }
}

export async function downloadFileBuffer(api: Api, fileId: string): Promise<Buffer> {
  const start = Date.now();
  try {
    const buffer = await withRetry(async () => {
      const file = await api.getFile(fileId);
      if (!file.file_path) throw new Error('No file_path in getFile response');

      const url = `https://api.telegram.org/file/bot${api.token}/` + file.file_path;
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Failed to download file: ${response.status}`);

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }, { retries: 2, delayMs: 1500 });

    logInfo('telegram.file_download.complete', {
      fileId,
      bytes: buffer.length,
      elapsedMs: Date.now() - start,
    });
    return buffer;
  } catch (err) {
    logWarn('telegram.file_download.failed', {
      fileId,
      elapsedMs: Date.now() - start,
      error: err,
    });
    throw err;
  }
}
