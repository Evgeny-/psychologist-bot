import cron from 'node-cron';
import type { Api } from 'grammy';
import { config } from '../config.js';
import { queries } from '../db/index.js';
import { t } from '../i18n/index.js';
import { todayLocal } from '../utils/date.js';
import { generateWeeklyReport, generateMonthlyReport } from './reports.js';

function daysSinceLastEntry(): number {
  const lastDate = queries.getLastEntryDate();
  if (!lastDate) return 999;
  const today = todayLocal();
  const lastMs = new Date(lastDate + 'T00:00:00').getTime();
  const todayMs = new Date(today + 'T00:00:00').getTime();
  return Math.floor((todayMs - lastMs) / (1000 * 60 * 60 * 24));
}

export function startScheduler(api: Api): void {
  const channelId = config.telegram.channelId;
  const groupId = config.telegram.discussionGroupId;
  const reminderChatId = groupId || channelId;

  if (!reminderChatId) return;

  // Daily reminder at 20:30 → group
  cron.schedule('30 20 * * *', async () => {
    try {
      const today = todayLocal();
      if (queries.hasEntryForDate(today)) return;

      const days = daysSinceLastEntry();
      const strings = t();
      const streak = queries.getStreak();

      let message: string;
      if (days <= 1) {
        message = strings.reminderDay1;
      } else {
        message = strings.reminderDay2plus.replace('{days}', String(days));
      }

      if (streak > 0) {
        message += `\n\n${strings.streakInfo.replace('{streak}', String(streak))}`;
      }

      await api.sendMessage(reminderChatId, message);
    } catch (err) {
      console.error('Scheduler: reminder error', err);
    }
  });

  // Weekly report: Monday at 10:00 → channel
  if (channelId) {
    cron.schedule('0 10 * * 1', async () => {
      try {
        await generateWeeklyReport(api, channelId);
      } catch (err) {
        console.error('Scheduler: weekly report error', err);
      }
    });

    // Monthly report: 1st of month at 10:00 → channel
    cron.schedule('0 10 1 * *', async () => {
      try {
        await generateMonthlyReport(api, channelId);
      } catch (err) {
        console.error('Scheduler: monthly report error', err);
      }
    });
  }

  console.log('Scheduler started: reminders at 20:30, weekly Mon 10:00, monthly 1st 10:00');
}
