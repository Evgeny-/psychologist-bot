import { InlineKeyboard } from 'grammy';
import { t } from '../i18n/index.js';

/**
 * Inline-button plumbing.
 *
 * Two constraints shape everything here. Telegram caps `callback_data` at 64 bytes, and Cyrillic
 * costs two bytes per character — so the payload is latin codes only. And Telegram draws the
 * keyboard under the whole message rather than where it sits in the text, so a message may carry
 * exactly one question, placed last; button captions still spell out the answer in full, because
 * that is what the reader sees when the buttons are detached from the sentence above them.
 */

export type CallbackKind = 'lbl' | 'ctr' | 'cred';

export interface CallbackPayload {
  kind: CallbackKind;
  /** Row reference: a label id, or a date for contracts and morning credits. */
  ref: string;
  value: string;
}

const SEP = ':';

export function encodeCallback(payload: CallbackPayload): string {
  const data = [payload.kind, payload.ref, payload.value].join(SEP);
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error(`callback_data over 64 bytes: ${data}`);
  }
  return data;
}

export function decodeCallback(data: string): CallbackPayload | null {
  const parts = data.split(SEP);
  if (parts.length !== 3) return null;
  const [kind, ref, value] = parts;
  if (kind !== 'lbl' && kind !== 'ctr' && kind !== 'cred') return null;
  if (!ref || !value) return null;
  return { kind, ref, value };
}

/** Yesterday evening's label, read back this morning. */
export function labelKeyboard(labelId: number): InlineKeyboard {
  const s = t();
  return new InlineKeyboard()
    .text(s.btnLabelYes, encodeCallback({ kind: 'lbl', ref: String(labelId), value: 'yes' }))
    .text(s.btnLabelNo, encodeCallback({ kind: 'lbl', ref: String(labelId), value: 'no' }))
    .text(s.btnLabelPartly, encodeCallback({ kind: 'lbl', ref: String(labelId), value: 'partly' }));
}

/** Did the one live contact happen. */
export function contractKeyboard(date: string): InlineKeyboard {
  const s = t();
  return new InlineKeyboard()
    .text(s.btnContractDone, encodeCallback({ kind: 'ctr', ref: date, value: 'done' }))
    .text(s.btnContractMissed, encodeCallback({ kind: 'ctr', ref: date, value: 'missed' }));
}

/** The credit for yesterday — the message that replaced the morning task. */
export function creditKeyboard(date: string): InlineKeyboard {
  const s = t();
  return new InlineKeyboard()
    .text(s.btnCreditYes, encodeCallback({ kind: 'cred', ref: date, value: 'yes' }))
    .text(s.btnCreditNo, encodeCallback({ kind: 'cred', ref: date, value: 'no' }))
    .text(s.btnCreditUnsure, encodeCallback({ kind: 'cred', ref: date, value: 'unsure' }));
}

/**
 * Replaces the keyboard after an answer, so the record shows what was answered and when.
 *
 * Keyed by kind as well as value: "yes" means "still true" on a label and "that is how it went"
 * on a credit, and keying by value alone made a tap on "Так и было" record itself as "всё ещё
 * так" — the record contradicted the button that produced it.
 *
 * Plain text on purpose. The edit re-sends the original message with its original entities
 * rather than re-parsing it, because `message.text` arrives stripped of formatting — rendering
 * it as HTML again would flatten every blockquote the message was built from.
 */
export function answeredLine(kind: CallbackKind, value: string, timeHHMM: string): string {
  const s = t();
  return `${s.answeredPrefix}: ${s.answerLabels[kind]?.[value] ?? value}, ${timeHHMM}`;
}
