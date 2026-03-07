import Database from 'better-sqlite3';

export function initDb(dbPath: string = 'data/cbt-bot.db'): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Migrate: drop old reports table with restrictive CHECK constraint
  const hasReports = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reports'").get();
  if (hasReports) {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reports'").get() as { sql: string } | undefined;
    if (tableInfo?.sql && !tableInfo.sql.includes('test_weekly')) {
      db.exec(`
        ALTER TABLE reports RENAME TO _reports_old;
        CREATE TABLE reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          period_start TEXT NOT NULL,
          period_end TEXT NOT NULL,
          report_text TEXT NOT NULL,
          llm_provider TEXT,
          llm_model TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO reports SELECT * FROM _reports_old;
        DROP TABLE _reports_old;
      `);
    }
  }

  // Migration: add self_esteem and productivity columns to metrics
  const hasSelfEsteem = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('metrics') WHERE name='self_esteem'").get() as { cnt: number };
  if (hasSelfEsteem.cnt === 0) {
    try {
      db.exec("ALTER TABLE metrics ADD COLUMN self_esteem INTEGER CHECK(self_esteem BETWEEN 0 AND 10)");
      db.exec("ALTER TABLE metrics ADD COLUMN productivity INTEGER CHECK(productivity BETWEEN 0 AND 10)");
    } catch { /* table may not exist yet */ }
  }

  // Migration: add local_time column to entries
  const hasLocalTime = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('entries') WHERE name='local_time'").get() as { cnt: number };
  if (hasLocalTime.cnt === 0) {
    try { db.exec("ALTER TABLE entries ADD COLUMN local_time TEXT"); } catch { /* table may not exist yet */ }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_message_id INTEGER NOT NULL,
      channel_post_id INTEGER,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('voice', 'text', 'forwarded_voice', 'forwarded_text')),
      raw_text TEXT,
      transcript TEXT,
      duration_seconds INTEGER,
      local_time TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL REFERENCES entries(id),
      analysis_text TEXT NOT NULL,
      sentiment TEXT CHECK(sentiment IN ('positive', 'neutral', 'negative')),
      distortions_json TEXT,
      topics_json TEXT,
      action_items_json TEXT,
      gratitude_count INTEGER DEFAULT 0,
      llm_provider TEXT,
      llm_model TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER REFERENCES entries(id),
      date TEXT NOT NULL,
      mood INTEGER CHECK(mood BETWEEN 0 AND 10),
      anxiety INTEGER CHECK(anxiety BETWEEN 0 AND 10),
      energy INTEGER CHECK(energy BETWEEN 0 AND 10),
      self_esteem INTEGER CHECK(self_esteem BETWEEN 0 AND 10),
      productivity INTEGER CHECK(productivity BETWEEN 0 AND 10),
      custom_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      report_text TEXT NOT NULL,
      llm_provider TEXT,
      llm_model TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS thread_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      llm_provider TEXT,
      llm_model TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
    CREATE INDEX IF NOT EXISTS idx_metrics_date ON metrics(date);
    CREATE INDEX IF NOT EXISTS idx_reports_period ON reports(type, period_start);
    CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_id);
  `);

  return db;
}
