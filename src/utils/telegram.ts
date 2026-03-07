import type { Api } from 'grammy';

const MAX_MESSAGE_LENGTH = 4096;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function markdownToHtml(text: string): string {
  // Process line by line for headers, then inline formatting
  const lines = text.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    // --- horizontal rule → empty line (Telegram doesn't support <hr>)
    if (/^-{3,}\s*$/.test(line)) {
      result.push('');
      continue;
    }

    let escaped = escapeHtml(line);

    // ### Header 3 → bold
    // ## Header 2 → bold
    // # Header 1 → bold
    escaped = escaped.replace(/^#{1,3}\s+(.+)$/, '<b>$1</b>');

    // **bold** → <b>bold</b>
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    // *italic* → <i>italic</i> (but not inside tags)
    escaped = escaped.replace(/(?<![<\/])\*(.+?)\*(?!>)/g, '<i>$1</i>');
    // `code` → <code>code</code>
    escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

    result.push(escaped);
  }

  return result.join('\n');
}

export function splitMessage(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) {
      // If newline is too early, try space
      splitAt = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      // Hard split if no good breakpoint
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

export async function sendSplitMessages(
  api: Api,
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<number[]> {
  const chunks = splitMessage(text);
  const messageIds: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const msg = await api.sendMessage(chatId, markdownToHtml(chunks[i]), {
      parse_mode: 'HTML',
      reply_to_message_id: i === 0 ? replyToMessageId : undefined,
    });
    messageIds.push(msg.message_id);
  }

  return messageIds;
}

export async function downloadFileBuffer(api: Api, fileId: string): Promise<Buffer> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error('No file_path in getFile response');

  const url = `https://api.telegram.org/file/bot${api.token}/` + file.file_path;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download file: ${response.status}`);

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
