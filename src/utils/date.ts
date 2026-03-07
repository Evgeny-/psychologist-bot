import { config } from '../config.js';

/** Current date in the bot's configured timezone as YYYY-MM-DD */
export function todayLocal(): string {
  return formatDateLocal(new Date());
}

/** Format a Date to YYYY-MM-DD in the bot's configured timezone */
export function formatDateLocal(d: Date): string {
  return d.toLocaleDateString('sv-SE', { timeZone: config.timezone });
}

/** Current local time as HH:MM */
export function nowLocalTime(): string {
  return new Date().toLocaleTimeString('en-GB', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
