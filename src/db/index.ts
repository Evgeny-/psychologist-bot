import { mkdirSync } from 'fs';
import type Database from 'better-sqlite3';
import { initDb } from './schema.js';
import { Queries } from './queries.js';

const DB_PATH = 'data/cbt-bot.db';

mkdirSync('data', { recursive: true });

export const db: Database.Database = initDb(DB_PATH);
export const queries = new Queries(db);
