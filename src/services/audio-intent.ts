import { createLLMProvider } from '../providers/llm/index.js';

const AUDIO_HINT_RE = /\b(audio|voice|voice note|voice message|spoken|listen|read it out|say it aloud|speak it|reply by voice|reply with audio|answer with audio|answer by voice|answer out loud|send audio)\b|(?:ответ(?:ь|ьте)|пришли|отправь|сделай).{0,24}\b(?:голос|голосом|аудио|войс|озвуч)|\b(?:голосом|аудио|войсом|слушать|озвучь|озвучка|надиктуй|прочитай вслух|ответь вслух)\b/iu;

const AUDIO_INTENT_SYSTEM_PROMPT = `You classify whether the user's latest message explicitly asks the assistant to DELIVER ITS REPLY as audio, voice, spoken output, or a voice note.

This is only about the desired response format.
- True: "reply with audio", "answer by voice", "send me a voice note", "I want to listen, not read", "ответь голосом", "пришли аудио ответ".
- False: mentions of music, podcasts, transcribing audio, audio quality, or narrating events that happened with audio, unless the user is clearly asking for THIS assistant reply to be spoken.

Return JSON only:
{"reply_audio_requested": true}
or
{"reply_audio_requested": false}`;

function parseAudioIntent(text: string): boolean | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? [undefined, text];
  try {
    const parsed = JSON.parse(jsonMatch[1] ?? text) as { reply_audio_requested?: unknown };
    if (typeof parsed.reply_audio_requested === 'boolean') {
      return parsed.reply_audio_requested;
    }
  } catch {
    return null;
  }
  return null;
}

function heuristicAudioIntent(text: string): boolean {
  return AUDIO_HINT_RE.test(text);
}

export async function detectAudioReplyRequest(userMessage: string): Promise<boolean> {
  const trimmed = userMessage.trim();
  if (!trimmed) return false;

  // Skip the extra classifier call for the common case where the message does not even hint at audio delivery.
  if (!heuristicAudioIntent(trimmed)) {
    return false;
  }

  try {
    const llm = createLLMProvider();
    const result = await llm.analyze(trimmed, AUDIO_INTENT_SYSTEM_PROMPT);
    const parsed = parseAudioIntent(result.text.trim());
    if (parsed !== null) return parsed;
  } catch (err) {
    console.warn('Audio intent classification failed:', err instanceof Error ? err.message : err);
  }

  return heuristicAudioIntent(trimmed);
}
