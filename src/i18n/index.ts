import { config, type BotLanguage } from '../config.js';
import { ru } from './ru.js';
import { en } from './en.js';

export interface Strings {
  transcriptHeader: string;
  analysisHeader: string;
  processingVoice: string;
  processingText: string;
  errorGeneric: string;
  errorApiBalance: string;
  errorApiGeneric: string;
  reminderDay1: string;
  reminderDay2plus: string;
  weeklyReportTitle: string;
  monthlyReportTitle: string;
  metricsAsk: string;
  streakInfo: string;
  statsHeader: string;
  statsStreak: string;
  statsTotalEntries: string;
  statsAvgMood: string;
  statsAvgAnxiety: string;
  statsAvgEnergy: string;
  statsNoMetrics: string;
  statsMetricsForDays: string;
  exportEmpty: string;
  metricsPatterns: {
    mood: readonly string[];
    anxiety: readonly string[];
    energy: readonly string[];
  };
}

const strings: Record<BotLanguage, Strings> = { ru, en };

export function t(): Strings {
  return strings[config.language];
}

export function lang(): BotLanguage {
  return config.language;
}
