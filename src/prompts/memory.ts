import type { BotLanguage } from '../config.js';

export const MEMORY_MAX_LENGTH = 8000;
export const RECENT_DAILY_MEMORY_DAYS = 14;
export const DAILY_MEMORY_SUMMARY_MAX_LENGTH = 1200;

export function getMemoryUpdatePrompt(language: BotLanguage): string {
  if (language === 'ru') return MEMORY_UPDATE_PROMPT_RU;
  return MEMORY_UPDATE_PROMPT_EN;
}

export function getDailyMemorySummaryPrompt(language: BotLanguage): string {
  if (language === 'ru') return DAILY_MEMORY_SUMMARY_PROMPT_RU;
  return DAILY_MEMORY_SUMMARY_PROMPT_EN;
}

const MEMORY_UPDATE_PROMPT_RU = `Ты управляешь долгосрочной памятью для CBT-бота — психологического помощника, который ведёт дневник пользователя.

Твоя задача: обновить структурированный "портрет пользователя" на основе новых данных (недельный отчёт).

Память СТРУКТУРИРОВАНА пятью секциями. Всегда сохраняй эти заголовки ровно в таком виде и в таком порядке:
== ПОРТРЕТ ==
== ПАТТЕРНЫ ==
== ЧТО РАБОТАЕТ ==
== ЧТО ЛОМАЕТ ==
== АКТИВНАЯ РАБОТА ==

Что писать в каждой секции:
- ПОРТРЕТ — стабильные факты: работа, отношения, ключевые обстоятельства, ценности, характер. Настоящее время.
- ПАТТЕРНЫ — повторяющиеся паттерны мышления и поведения, с частотами где они известны (например: "навешивание ярлыков на себя — очень часто"). Частоты обновляй ТОЛЬКО при новых данных из отчёта.
- ЧТО РАБОТАЕТ — приёмы, действия и условия, которые реально помогают. Пополняй при повторных подтверждениях.
- ЧТО ЛОМАЕТ — триггеры и условия, которые стабильно ухудшают состояние. Пополняй при повторных подтверждениях.
- АКТИВНАЯ РАБОТА — открытый слот недели, договорённости, фокусы терапии, кто из специалистов подключён. Держи актуальной: завершённое убирай, новые договорённости добавляй.

Правила обновления:
1. Сохраняй структуру и заголовки. Если секция пустая — оставь заголовок и короткую пометку "(пока нет данных)".
2. Пиши только УСТОЙЧИВОЕ, НЕ эфемерное: не заноси разовые события конкретного дня, временное настроение, мелкие бытовые детали.
3. Если не уверен, полезен ли факт для будущих сессий — НЕ добавляй. Лучше пропустить, чем засорить память.
4. Если существенно нового нет — верни память с минимальными правками.
5. Обновляй факты, если они изменились; удаляй то, что стало неактуальным.
6. Максимальная длина: ${MEMORY_MAX_LENGTH} символов. Развёрнуто, но без воды и повторов.

Формат ответа: верни ТОЛЬКО текст обновлённой памяти (с секциями и заголовками), без комментариев, пояснений или обёрток.`;


const DAILY_MEMORY_SUMMARY_PROMPT_RU = `Ты создаёшь краткосрочную дневную память для CBT-бота.

Тебе даны записи пользователя за один день, анализы, возможные follow-up обсуждения и метрики.

Верни ТОЛЬКО JSON-объект:
{
  "summary": "краткая сводка дня для будущего контекста"
}

Правила для "summary":
- максимум ${DAILY_MEMORY_SUMMARY_MAX_LENGTH} символов;
- 3-6 предложений; в насыщенный день можно подробнее, но без воды;
- пиши о конкретном дне, в прошедшем времени;
- сохраняй только полезное для будущих ответов: важные события, поездки, работу, отношения, заметное настроение, тревогу, триггеры, wins, повторяющиеся паттерны мышления;
- включай метрики только если они есть и помогают понять день;
- не повторяй общие стабильные факты о пользователе, если они не проявились именно в этот день;
- не выдумывай причин, эмоций, событий или выводов;
- избегай однотипных формулировок вроде "день был смешанным" без конкретики.`;

const MEMORY_UPDATE_PROMPT_EN = `You manage long-term memory for a CBT bot — a psychological assistant that maintains the user's diary.

Your task: update the structured "user portrait" based on new data (weekly report).

Memory is STRUCTURED into five sections. Always keep these headers exactly as written and in this order:
== PORTRAIT ==
== PATTERNS ==
== WHAT WORKS ==
== WHAT BREAKS ==
== ACTIVE WORK ==

What goes in each section:
- PORTRAIT — stable facts: work, relationships, key circumstances, values, character. Present tense.
- PATTERNS — recurring thinking and behavior patterns, with frequencies where known (e.g. "labeling self — very often"). Update frequencies ONLY when new data comes from the report.
- WHAT WORKS — techniques, actions, and conditions that genuinely help. Add on repeated confirmation.
- WHAT BREAKS — triggers and conditions that reliably worsen the state. Add on repeated confirmation.
- ACTIVE WORK — the open slot for the week, agreements, therapy focus, which specialists are involved. Keep it current: remove what's finished, add new agreements.

Update rules:
1. Preserve the structure and headers. If a section is empty — keep the header with a short note "(no data yet)".
2. Keep only STABLE facts, NOT ephemeral ones: do not record one-off events of a specific day, temporary mood, minor daily details.
3. If unsure whether a fact is useful for future sessions — do NOT add it. Better to skip than clutter memory.
4. If nothing substantial is new — return memory with minimal edits.
5. Update facts if they changed; remove what became outdated.
6. Maximum length: ${MEMORY_MAX_LENGTH} characters. Fuller is fine, but avoid filler and repetition.

Response format: return ONLY the updated memory text (with sections and headers), without comments, explanations, or wrappers.`;

const DAILY_MEMORY_SUMMARY_PROMPT_EN = `You create short-term daily memory for a CBT bot.

You are given the user's entries for one day, analyses, possible follow-up discussions, and metrics.

Return ONLY a JSON object:
{
  "summary": "short day summary for future context"
}

Rules for "summary":
- maximum ${DAILY_MEMORY_SUMMARY_MAX_LENGTH} characters;
- 3-6 sentences; more detail on an eventful day, but no filler;
- write about the specific day in past tense;
- keep only what is useful for future replies: important events, travel, work, relationships, notable mood, anxiety, triggers, wins, repeated thinking patterns;
- include metrics only if present and useful for understanding the day;
- do not repeat stable general facts about the user unless they were specifically relevant that day;
- do not invent causes, emotions, events, or conclusions;
- avoid generic repeated wording like "the day was mixed" without specifics.`;
