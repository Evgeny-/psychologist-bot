export const en = {
  transcriptHeader: '--- Transcript ---',
  analysisHeader: '--- Analysis ---',
  processingVoice: 'Processing voice message...',
  processingText: 'Analyzing...',
  errorGeneric: 'An error occurred while processing the message. Will try again later.',
  errorApiBalance: '⚠️ API error: possibly out of balance. Check the provider account.',
  errorApiGeneric: '⚠️ API error ({provider}): {message}',
  reminderDay1: 'Hey! No entry today yet. How was your day?',
  reminderDay2plus: "It's been {days} days without entries. Even a short message is better than nothing.",
  weeklyReportTitle: '--- Weekly Report ({start} — {end}) ---',
  monthlyReportTitle: '--- Monthly Report ({start} — {end}) ---',
  metricsAsk: "Don't forget your metrics: mood, anxiety, energy (0-10)",
  metricsPatterns: {
    mood: ['mood', 'm'],
    anxiety: ['anxiety', 'a'],
    energy: ['energy', 'e'],
  },
} as const;
