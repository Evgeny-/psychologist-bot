import { config, type BotLanguage } from '../config.js';
import { ru } from './ru.js';
import { en } from './en.js';

export interface Strings {
  transcriptHeader: string;
  audioFallbackNotice: string;
  audioReplyUnavailable: string;
  processingVoice: string;
  errorGeneric: string;
  errorApiBalance: string;
  errorApiGeneric: string;
  reminderDay1: string;
  reminderDay2plus: string;
  weeklyReportTitle: string;
  monthlyReportTitle: string;
  chartTitle: string;
  chartCaption: string;
  chartPanelPositive: string;
  chartPanelNegative: string;
  chartWeekend: string;
  metricsAsk: string;
  streakInfo: string;
  exportEmpty: string;
  metricNames: {
    mood: string;
    anxiety: string;
    stress: string;
    productivity: string;
    routine: string;
  };
}

const strings: Record<BotLanguage, Strings> = { ru, en };

export function t(): Strings {
  return strings[config.language];
}

export function lang(): BotLanguage {
  return config.language;
}
