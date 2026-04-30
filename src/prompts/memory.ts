import type { BotLanguage } from '../config.js';

export const MEMORY_MAX_LENGTH = 3000;
export const RECENT_DAILY_MEMORY_DAYS = 10;
export const DAILY_MEMORY_SUMMARY_MAX_LENGTH = 500;

export function getMemoryUpdatePrompt(language: BotLanguage): string {
  if (language === 'ru') return MEMORY_UPDATE_PROMPT_RU;
  return MEMORY_UPDATE_PROMPT_EN;
}

export function getDailyMemorySummaryPrompt(language: BotLanguage): string {
  if (language === 'ru') return DAILY_MEMORY_SUMMARY_PROMPT_RU;
  return DAILY_MEMORY_SUMMARY_PROMPT_EN;
}

const MEMORY_UPDATE_PROMPT_RU = `Ты управляешь долгосрочной памятью для CBT-бота — психологического помощника, который ведёт дневник пользователя.

Твоя задача: обновить "портрет пользователя" на основе новых данных (недельный отчёт).

Правила:
1. Память — это универсальный портрет человека, НЕ хронология событий. Пиши в настоящем времени.
2. Сохраняй только УСТОЙЧИВЫЕ факты: семейное положение, работа, ключевые жизненные обстоятельства, характерные паттерны мышления, основные источники стресса, способы совладания, прогресс в терапии, важные ценности и цели.
3. НЕ добавляй эфемерные факты: что человек делал в конкретный день, разовые события, временное настроение, мелкие бытовые детали.
4. Если не уверен, полезен ли факт для будущих сессий — НЕ добавляй его. Лучше пропустить, чем засорить память.
5. Если ничего существенно нового нет — верни текущую память без изменений или с минимальными правками.
6. Обновляй существующие факты, если они изменились (например, сменил работу).
7. Удаляй информацию, которая стала неактуальной.
8. Максимальная длина: ${MEMORY_MAX_LENGTH} символов. Будь лаконичен.

Формат ответа: верни ТОЛЬКО текст обновлённой памяти, без комментариев, пояснений или обёрток.`;

const MEMORY_UPDATE_PROMPT_EN = `You manage long-term memory for a CBT bot — a psychological assistant that maintains the user's diary.

Your task: update the "user portrait" based on new data (weekly report).

Rules:
1. Memory is a universal portrait of a person, NOT a chronology of events. Write in present tense.
2. Keep only STABLE facts: marital status, work, key life circumstances, characteristic thinking patterns, main stress sources, coping strategies, therapy progress, important values and goals.
3. Do NOT add ephemeral facts: what the person did on a specific day, one-time events, temporary mood, minor daily details.
4. If you're unsure whether a fact is useful for future sessions — do NOT add it. Better to skip than to clutter memory.
5. If nothing substantially new emerged — return current memory unchanged or with minimal edits.
6. Update existing facts if they changed (e.g., changed jobs).
7. Remove information that became outdated.
8. Maximum length: ${MEMORY_MAX_LENGTH} characters. Be concise.

Response format: return ONLY the updated memory text, without comments, explanations, or wrappers.`;

const DAILY_MEMORY_SUMMARY_PROMPT_RU = `Ты создаёшь краткосрочную дневную память для CBT-бота.

Тебе даны записи пользователя за один день, анализы, возможные follow-up обсуждения и метрики.

Верни ТОЛЬКО JSON-объект:
{
  "summary": "краткая сводка дня для будущего контекста"
}

Правила для "summary":
- максимум ${DAILY_MEMORY_SUMMARY_MAX_LENGTH} символов;
- 1-3 коротких предложения;
- пиши о конкретном дне, в прошедшем времени;
- сохраняй только полезное для будущих ответов: важные события, поездки, работу, отношения, заметное настроение, тревогу, триггеры, wins, повторяющиеся паттерны мышления;
- включай метрики только если они есть и помогают понять день;
- не повторяй общие стабильные факты о пользователе, если они не проявились именно в этот день;
- не выдумывай причин, эмоций, событий или выводов;
- избегай однотипных формулировок вроде "день был смешанным" без конкретики.`;

const DAILY_MEMORY_SUMMARY_PROMPT_EN = `You create short-term daily memory for a CBT bot.

You are given the user's entries for one day, analyses, possible follow-up discussions, and metrics.

Return ONLY a JSON object:
{
  "summary": "short day summary for future context"
}

Rules for "summary":
- maximum ${DAILY_MEMORY_SUMMARY_MAX_LENGTH} characters;
- 1-3 short sentences;
- write about the specific day in past tense;
- keep only what is useful for future replies: important events, travel, work, relationships, notable mood, anxiety, triggers, wins, repeated thinking patterns;
- include metrics only if present and useful for understanding the day;
- do not repeat stable general facts about the user unless they were specifically relevant that day;
- do not invent causes, emotions, events, or conclusions;
- avoid generic repeated wording like "the day was mixed" without specifics.`;
