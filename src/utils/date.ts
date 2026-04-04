import { config } from '../config.js';

/** Current date in the bot's configured timezone as YYYY-MM-DD */
export function todayLocal(): string {
  return formatDateLocal(new Date());
}

/** Format a Date to YYYY-MM-DD in the bot's configured timezone */
export function formatDateLocal(d: Date): string {
  return d.toLocaleDateString('sv-SE', { timeZone: config.timezone });
}

/** Shift a YYYY-MM-DD date by a whole number of days without depending on server timezone. */
export function shiftLocalDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().split('T')[0];
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
