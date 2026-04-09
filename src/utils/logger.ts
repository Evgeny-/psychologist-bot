import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';
type LogFields = Record<string, unknown>;

const LOG_DIR = resolve(process.cwd(), 'logs');
const LOG_FILE_PATH = resolve(LOG_DIR, 'app.log');

mkdirSync(LOG_DIR, { recursive: true });

const stream = createWriteStream(LOG_FILE_PATH, { flags: 'a' });

function truncate(value: string, maxLength = 1200): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function normalizeValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack ? truncate(value.stack.replace(/\s+/g, ' ')) : undefined,
    });
  }
  if (typeof value === 'string') {
    return JSON.stringify(truncate(value.replace(/\s+/g, ' '), 400));
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

function buildLine(level: LogLevel, event: string, fields: LogFields): string {
  const parts = [
    `ts=${new Date().toISOString()}`,
    `level=${level}`,
    `pid=${process.pid}`,
    `event=${event}`,
  ];

  for (const key of Object.keys(fields).sort()) {
    const normalized = normalizeValue(fields[key]);
    if (normalized !== undefined) {
      parts.push(`${key}=${normalized}`);
    }
  }

  return parts.join(' ');
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  const line = buildLine(level, event, fields);
  stream.write(`${line}\n`);

  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logInfo(event: string, fields: LogFields = {}): void {
  emit('INFO', event, fields);
}

export function logWarn(event: string, fields: LogFields = {}): void {
  emit('WARN', event, fields);
}

export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  emit('ERROR', event, { ...fields, error });
}

export function getLogFilePath(): string {
  return LOG_FILE_PATH;
}
