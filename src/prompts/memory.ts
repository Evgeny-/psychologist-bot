import type { BotLanguage } from '../config.js';

export const MEMORY_MAX_LENGTH = 3000;

export function getMemoryUpdatePrompt(language: BotLanguage): string {
  if (language === 'ru') return MEMORY_UPDATE_PROMPT_RU;
  return MEMORY_UPDATE_PROMPT_EN;
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
