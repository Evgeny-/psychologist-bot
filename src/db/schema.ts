import Database from 'better-sqlite3';

export function initDb(dbPath: string = 'data/cbt-bot.db'): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  function addMetricColumnIfMissing(name: string, definition: string): void {
    const hasColumn = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('metrics') WHERE name = ?").get(name) as { cnt: number };
    if (hasColumn.cnt === 0) {
      try {
        db.exec(`ALTER TABLE metrics ADD COLUMN ${name} ${definition}`);
      } catch { /* table may not exist yet */ }
    }
  }

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

  // Migrations: add active metric columns to existing metrics tables.
  // Legacy columns such as self_esteem and energy may exist in old DBs, but new code no longer writes them.
  addMetricColumnIfMissing('productivity', 'INTEGER CHECK(productivity BETWEEN 0 AND 10)');
  addMetricColumnIfMissing('stress', 'INTEGER CHECK(stress BETWEEN 0 AND 10)');
  addMetricColumnIfMissing('routine', 'INTEGER CHECK(routine BETWEEN 0 AND 10)');

  // Migration: add emotions_json, triggers_json, wins_json columns to analyses
  const hasEmotions = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('analyses') WHERE name='emotions_json'").get() as { cnt: number };
  if (hasEmotions.cnt === 0) {
    try {
      db.exec("ALTER TABLE analyses ADD COLUMN emotions_json TEXT");
      db.exec("ALTER TABLE analyses ADD COLUMN triggers_json TEXT");
      db.exec("ALTER TABLE analyses ADD COLUMN wins_json TEXT");
    } catch { /* table may not exist yet */ }
  }

  // Migration: add local_time column to entries
  const hasLocalTime = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('entries') WHERE name='local_time'").get() as { cnt: number };
  if (hasLocalTime.cnt === 0) {
    try { db.exec("ALTER TABLE entries ADD COLUMN local_time TEXT"); } catch { /* table may not exist yet */ }
  }

  // Migration: drop experiment_events.counted — always written as 1, never read
  const hasCounted = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('experiment_events') WHERE name='counted'").get() as { cnt: number };
  if (hasCounted.cnt > 0) {
    try { db.exec("ALTER TABLE experiment_events DROP COLUMN counted"); } catch { /* SQLite without DROP COLUMN support */ }
  }

  // Migration: orbit theme tags on analyses (closed taxonomy, see src/prompts/orbits.ts)
  const hasOrbitThemes = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('analyses') WHERE name='orbit_themes_json'").get() as { cnt: number };
  if (hasOrbitThemes.cnt === 0) {
    try { db.exec("ALTER TABLE analyses ADD COLUMN orbit_themes_json TEXT"); } catch { /* table may not exist yet */ }
  }

  // Migration: persist the bot's closing question so later prompts can avoid repeating it.
  // Repetition is the failure mode this loop is built to avoid: a recommendation that lands
  // three times without being acted on teaches the reader to skip the channel.
  const hasClosingQuestion = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('analyses') WHERE name='closing_question'").get() as { cnt: number };
  if (hasClosingQuestion.cnt === 0) {
    try { db.exec("ALTER TABLE analyses ADD COLUMN closing_question TEXT"); } catch { /* table may not exist yet */ }
  }

  // Migration: the sayable alternative to a self-directed verdict. Stored so the prompt can see
  // what it already offered — offering the same sentence every evening turns it into wallpaper.
  const hasSayInstead = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('analyses') WHERE name='say_instead_json'").get() as { cnt: number };
  if (hasSayInstead.cnt === 0) {
    try { db.exec("ALTER TABLE analyses ADD COLUMN say_instead_json TEXT"); } catch { /* table may not exist yet */ }
  }

  // Migration: entry provenance — 'live' (telegram) vs 'archive' (imported past diaries)
  const hasSource = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('entries') WHERE name='source'").get() as { cnt: number };
  if (hasSource.cnt === 0) {
    try { db.exec("ALTER TABLE entries ADD COLUMN source TEXT NOT NULL DEFAULT 'live'"); } catch { /* table may not exist yet */ }
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
      source TEXT NOT NULL DEFAULT 'live',
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
      emotions_json TEXT,
      triggers_json TEXT,
      wins_json TEXT,
      orbit_themes_json TEXT,
      closing_question TEXT,
      say_instead_json TEXT,
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
      stress INTEGER CHECK(stress BETWEEN 0 AND 10),
      productivity INTEGER CHECK(productivity BETWEEN 0 AND 10),
      routine INTEGER CHECK(routine BETWEEN 0 AND 10),
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

    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      content TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_memory (
      date TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      source_entry_id INTEGER REFERENCES entries(id),
      llm_provider TEXT,
      llm_model TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      success_criterion TEXT,
      target_count INTEGER,
      progress_count INTEGER DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('active', 'done', 'skipped')) DEFAULT 'active',
      start_date TEXT NOT NULL,
      end_date TEXT,
      result_note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS experiment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL REFERENCES experiments(id),
      entry_id INTEGER REFERENCES entries(id),
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entry_embeddings (
      entry_id INTEGER PRIMARY KEY REFERENCES entries(id),
      model TEXT NOT NULL,
      vector BLOB NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orbit_meta (
      theme_key TEXT PRIMARY KEY,
      archive_note TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO memory (id, content) VALUES (1, '');

    -- One binary contract per day: a single live contact made before the workday starts.
    -- Binary on purpose — the previous "weekly experiment" format failed because it could
    -- always be counted as done "in spirit"; "yes/no" cannot.
    CREATE TABLE IF NOT EXISTS contracts (
      date TEXT PRIMARY KEY,
      text TEXT,
      status TEXT NOT NULL CHECK(status IN ('open', 'done', 'missed')) DEFAULT 'open',
      resolved_entry_id INTEGER REFERENCES entries(id),
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    -- A slot is a commitment that already costs something: a booked date, a paid seat,
    -- another person expecting you. Intentions without one of those do not survive.
    CREATE TABLE IF NOT EXISTS slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL,
      text TEXT NOT NULL,
      when_at TEXT,
      who TEXT,
      cost TEXT,
      status TEXT NOT NULL CHECK(status IN ('open', 'kept', 'missed')) DEFAULT 'open',
      result_note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT
    );

    -- Verbatim labels, kept for the next morning's review. The point is not to argue with
    -- the label in the moment (that never works) but to ask twelve hours later whether it
    -- still holds, and to accumulate the answer as a counter.
    CREATE TABLE IF NOT EXISTS labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER REFERENCES entries(id),
      date TEXT NOT NULL,
      said_at TEXT,
      quote TEXT NOT NULL,
      verdict TEXT CHECK(verdict IN ('yes', 'no', 'partly')),
      reviewed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- External evidence that the work landed: someone's reaction, praise, a thing shipped
    -- and noticed. Separate from the wins field because only externally sourced evidence
    -- counts as proof for this user; his own effort does not.
    CREATE TABLE IF NOT EXISTS credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER REFERENCES entries(id),
      date TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- The morning message stopped being a task for today and became a credit for yesterday.
    -- One question per morning, answered with one tap; "unsure" is a legitimate outcome, without
    -- it the counter degrades into a tally of failures.
    CREATE TABLE IF NOT EXISTS morning_credits (
      date TEXT PRIMARY KEY,
      source_date TEXT NOT NULL,
      quote TEXT,
      skill TEXT,
      counter TEXT,
      verdict TEXT CHECK(verdict IN ('yes', 'no', 'unsure')),
      message_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      answered_at TEXT
    );

    -- A permanent blacklist. Some topics he has refused outright ("правило про 24 часа меня
    -- очень бесит"), and a generator that rediscovers them every few weeks is worse than one
    -- that never had the idea. Rows are never expired: a veto is a standing instruction.
    CREATE TABLE IF NOT EXISTS vetoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
    CREATE INDEX IF NOT EXISTS idx_metrics_date ON metrics(date);
    CREATE INDEX IF NOT EXISTS idx_reports_period ON reports(type, period_start);
    CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_daily_memory_date ON daily_memory(date);
    CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);
    CREATE INDEX IF NOT EXISTS idx_experiment_events_experiment ON experiment_events(experiment_id);
    CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
    CREATE INDEX IF NOT EXISTS idx_slots_status ON slots(status);
    CREATE INDEX IF NOT EXISTS idx_labels_date ON labels(date);
    CREATE INDEX IF NOT EXISTS idx_credits_date ON credits(date);
    CREATE INDEX IF NOT EXISTS idx_morning_credits_verdict ON morning_credits(verdict);
  `);

  // Guard against double-counting: at most one experiment event per (experiment, entry).
  // NULL entry_id rows are exempt (SQLite treats NULLs as distinct in unique indexes).
  // If historical duplicates block index creation, keep the earliest row per pair.
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_experiment_events_entry ON experiment_events(experiment_id, entry_id)');
  } catch {
    db.exec(`
      DELETE FROM experiment_events WHERE entry_id IS NOT NULL AND id NOT IN (
        SELECT MIN(id) FROM experiment_events WHERE entry_id IS NOT NULL GROUP BY experiment_id, entry_id
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_experiment_events_entry ON experiment_events(experiment_id, entry_id);
    `);
  }

  return db;
}
