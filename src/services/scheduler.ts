import cron from 'node-cron';
import type { Api } from 'grammy';
import { config } from '../config.js';
import { queries } from '../db/index.js';
import { t } from '../i18n/index.js';
import { todayLocal } from '../utils/date.js';
import { generateWeeklyReport, generateMonthlyReport, generateMorningBrief } from './reports.js';
import { logError, logInfo } from '../utils/logger.js';

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
  const reminderChatId = channelId || groupId;
  const cronOptions = { timezone: config.timezone };

  if (!reminderChatId && !channelId) return;

  // Daily reminder at 20:30 → channel, with discussion group as a fallback.
  if (reminderChatId) {
    cron.schedule('30 20 * * *', async () => {
      try {
        const today = todayLocal();
        if (queries.hasEntryForDate(today)) {
          logInfo('scheduler.reminder.skip_has_entry', { today, reminderChatId });
          return;
        }

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

        await api.sendMessage(reminderChatId, `${message}\n\n#bot`);
        logInfo('scheduler.reminder.sent', { today, reminderChatId, daysSinceLastEntry: days, streak });
      } catch (err) {
        logError('scheduler.reminder.failed', err, { reminderChatId });
      }
    }, cronOptions);
  }

  if (channelId) {
    // Morning brief: every day at 08:00 → channel
    cron.schedule('0 8 * * *', async () => {
      try {
        logInfo('scheduler.morning.tick', { channelId });
        await generateMorningBrief(api, channelId);
      } catch (err) {
        logError('scheduler.morning.failed', err, { channelId });
      }
    }, cronOptions);

    // Weekly report: Monday at 10:00 → channel
    cron.schedule('0 10 * * 1', async () => {
      try {
        logInfo('scheduler.weekly.tick', { channelId });
        await generateWeeklyReport(api, channelId);
      } catch (err) {
        logError('scheduler.weekly.failed', err, { channelId });
      }
    }, cronOptions);

    // Monthly report: 1st of month at 10:00 → channel
    cron.schedule('0 10 1 * *', async () => {
      try {
        logInfo('scheduler.monthly.tick', { channelId });
        await generateMonthlyReport(api, channelId);
      } catch (err) {
        logError('scheduler.monthly.failed', err, { channelId });
      }
    }, cronOptions);
  }

  logInfo('scheduler.started', {
    timezone: config.timezone,
    reminderChatId,
    channelId,
    morningAt: '08:00',
    reminderAt: '20:30',
    weeklyAt: 'Mon 10:00',
    monthlyAt: '1st 10:00',
  });
}
