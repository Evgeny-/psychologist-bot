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
  morningHeaderCredit: string;
  morningHeaderLabel: string;
  morningCreditHeader: string;
  morningCreditAsk: string;
  labelAskPrefix: string;
  labelAskQuestion: string;
  contractAsk: string;
  btnLabelYes: string;
  btnLabelNo: string;
  btnLabelPartly: string;
  btnContractDone: string;
  btnContractMissed: string;
  btnCreditYes: string;
  btnCreditNo: string;
  btnCreditUnsure: string;
  answeredPrefix: string;
  answerLabels: Record<string, string>;
  toastSaved: string;
  toastDropped: string;
  toastForeignButton: string;
  toastSaveFailed: string;
  vetoEmpty: string;
  vetoHint: string;
  vetoListHeader: string;
  vetoAdded: string;
  vetoRemoved: string;
  vetoNotFound: string;
  creditedLabel: string;
  thoughtsOfDayHeader: string;
  metricShort: {
    mood: string;
    anxiety: string;
    stress: string;
    productivity: string;
    routine: string;
  };
  sayInsteadHeader: string;
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
