import type { BotLanguage } from '../config.js';

/**
 * Closed taxonomy of recurring themes ("orbits") the analysis tags entries with.
 * Counting repeated themes deterministically (SQL over tags) is what powers the
 * anti-rumination register: the bot names the repetition instead of re-analyzing it.
 *
 * Keys are stable identifiers stored in analyses.orbit_themes_json — never rename.
 * Definitions here are generic; per-user historical notes live in the orbit_meta
 * DB table (seeded manually, never in this public repo).
 */
export interface OrbitTheme {
  key: string;
  label: { ru: string; en: string };
  definition: { ru: string; en: string };
}

export const ORBIT_THEMES: OrbitTheme[] = [
  {
    key: 'work_recognition',
    label: { ru: 'Признание на работе', en: 'Recognition at work' },
    definition: {
      ru: 'Реакция (или её отсутствие) на его работу: тишина в чате, лайки, похвала, оценка, сравнение с коллегами, «моя работа никому не нужна».',
      en: 'Reaction (or silence) to his work: quiet channels, likes, praise, evaluation, comparing to colleagues, "my work matters to no one".',
    },
  },
  {
    key: 'partner_conflict',
    label: { ru: 'Конфликт/обида в паре', en: 'Partner conflict/resentment' },
    definition: {
      ru: 'Обиды, претензии, холод, мысли «мы не подходим друг другу», желание дистанции от партнёра.',
      en: 'Resentment, grievances, coldness, "we are not right for each other" thoughts, wanting distance from the partner.',
    },
  },
  {
    key: 'trigger_anger',
    label: { ru: 'Гнев на бытовые триггеры', en: 'Anger at everyday triggers' },
    definition: {
      ru: 'Вспышки раздражения на медлительность, звуки (чавканье, топанье), «тупость» окружающих, очереди, сервисы.',
      en: 'Irritation flashes at slowness, sounds (chewing, stomping), other people\'s "stupidity", queues, services.',
    },
  },
  {
    key: 'life_passing',
    label: { ru: '«Жизнь проходит мимо»', en: '"Life passing by"' },
    definition: {
      ru: 'Пустота, «ничего не чувствую», «хочется настоящего», день или жизнь прожиты зря, бег на месте.',
      en: 'Emptiness, "I feel nothing", "I want something real", day or life wasted, running in place.',
    },
  },
  {
    key: 'self_labeling',
    label: { ru: 'Ярлыки на себя', en: 'Self-labeling' },
    definition: {
      ru: 'Глобальные негативные выводы о себе («я лох/клоун/тупой/не на своём месте»), сравнение себя с другими не в свою пользу.',
      en: 'Global negative self-verdicts ("I\'m a loser/clown/stupid/don\'t belong"), unfavorable self-comparison.',
    },
  },
  {
    key: 'health_worry',
    label: { ru: 'Здоровье и лечение', en: 'Health and treatment' },
    definition: {
      ru: 'Хроническая болезнь, ЖКТ, гормоны, усталость без причины, сон, эффективность лечения.',
      en: 'Chronic illness, gut, hormones, unexplained fatigue, sleep, treatment effectiveness.',
    },
  },
  {
    key: 'money_anxiety',
    label: { ru: 'Деньги', en: 'Money' },
    definition: {
      ru: '«Не копится», крупные траты, чужие долги, тревога о финансовой подушке.',
      en: '"Savings won\'t grow", big expenses, others\' debts, safety-cushion anxiety.',
    },
  },
  {
    key: 'isolation',
    label: { ru: 'Одиночество/изоляция', en: 'Loneliness/isolation' },
    definition: {
      ru: 'Нехватка друзей и живого общения, окукливание, страх выйти к людям, «не с кем разделить».',
      en: 'Lack of friends and live contact, cocooning, fear of going out to people, "no one to share with".',
    },
  },
  {
    key: 'uncertainty_control',
    label: { ru: 'Неопределённость и контроль', en: 'Uncertainty and control' },
    definition: {
      ru: 'Тревога от неопределённости, откладывание решений, невозможность начать, «вечное обдумывание».',
      en: 'Anxiety from uncertainty, postponed decisions, inability to start, "eternal deliberation".',
    },
  },
];

const KEY_SET = new Set(ORBIT_THEMES.map((t) => t.key));

export function isOrbitThemeKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_SET.has(key);
}

export function getOrbitTheme(key: string): OrbitTheme | undefined {
  return ORBIT_THEMES.find((t) => t.key === key);
}

/** Taxonomy list for the daily system prompt (Part A tagging instructions). */
export function renderOrbitTaxonomy(language: BotLanguage): string {
  const lang = language === 'ru' ? 'ru' : 'en';
  return ORBIT_THEMES
    .map((t) => `- ${t.key} — ${t.label[lang]}: ${t.definition[lang]}`)
    .join('\n');
}
