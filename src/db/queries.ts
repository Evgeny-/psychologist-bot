import type Database from 'better-sqlite3';

export interface EntryRow {
  id: number;
  telegram_message_id: number;
  channel_post_id: number | null;
  date: string;
  type: string;
  raw_text: string | null;
  transcript: string | null;
  duration_seconds: number | null;
  created_at: string;
}

export interface AnalysisRow {
  id: number;
  entry_id: number;
  analysis_text: string;
  sentiment: string | null;
  distortions_json: string | null;
  topics_json: string | null;
  action_items_json: string | null;
  gratitude_count: number;
  llm_provider: string | null;
  llm_model: string | null;
  created_at: string;
}

export interface MetricsRow {
  id: number;
  entry_id: number | null;
  date: string;
  mood: number | null;
  anxiety: number | null;
  energy: number | null;
  custom_json: string | null;
  created_at: string;
}

export interface ReportRow {
  id: number;
  type: string;
  period_start: string;
  period_end: string;
  report_text: string;
  llm_provider: string | null;
  llm_model: string | null;
  created_at: string;
}

export interface ThreadMessageRow {
  id: number;
  thread_id: number;
  role: 'user' | 'assistant';
  content: string;
  llm_provider: string | null;
  llm_model: string | null;
  created_at: string;
}

export class Queries {
  constructor(private db: Database.Database) {}

  insertEntry(entry: {
    telegram_message_id: number;
    channel_post_id?: number;
    date: string;
    type: string;
    raw_text?: string;
    transcript?: string;
    duration_seconds?: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO entries (telegram_message_id, channel_post_id, date, type, raw_text, transcript, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      entry.telegram_message_id,
      entry.channel_post_id ?? null,
      entry.date,
      entry.type,
      entry.raw_text ?? null,
      entry.transcript ?? null,
      entry.duration_seconds ?? null,
    );
    return result.lastInsertRowid as number;
  }

  updateEntryTranscript(id: number, transcript: string): void {
    this.db.prepare('UPDATE entries SET transcript = ? WHERE id = ?').run(transcript, id);
  }

  insertAnalysis(analysis: {
    entry_id: number;
    analysis_text: string;
    sentiment?: string;
    distortions_json?: string;
    topics_json?: string;
    action_items_json?: string;
    gratitude_count?: number;
    llm_provider?: string;
    llm_model?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO analyses (entry_id, analysis_text, sentiment, distortions_json, topics_json, action_items_json, gratitude_count, llm_provider, llm_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      analysis.entry_id,
      analysis.analysis_text,
      analysis.sentiment ?? null,
      analysis.distortions_json ?? null,
      analysis.topics_json ?? null,
      analysis.action_items_json ?? null,
      analysis.gratitude_count ?? 0,
      analysis.llm_provider ?? null,
      analysis.llm_model ?? null,
    );
    return result.lastInsertRowid as number;
  }

  insertMetrics(metrics: {
    entry_id?: number;
    date: string;
    mood?: number;
    anxiety?: number;
    energy?: number;
    custom_json?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO metrics (entry_id, date, mood, anxiety, energy, custom_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      metrics.entry_id ?? null,
      metrics.date,
      metrics.mood ?? null,
      metrics.anxiety ?? null,
      metrics.energy ?? null,
      metrics.custom_json ?? null,
    );
    return result.lastInsertRowid as number;
  }

  insertReport(report: {
    type: string;
    period_start: string;
    period_end: string;
    report_text: string;
    llm_provider?: string;
    llm_model?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO reports (type, period_start, period_end, report_text, llm_provider, llm_model)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      report.type,
      report.period_start,
      report.period_end,
      report.report_text,
      report.llm_provider ?? null,
      report.llm_model ?? null,
    );
    return result.lastInsertRowid as number;
  }

  getEntriesByDateRange(start: string, end: string): EntryRow[] {
    return this.db.prepare(
      'SELECT * FROM entries WHERE date >= ? AND date <= ? ORDER BY created_at ASC'
    ).all(start, end) as EntryRow[];
  }

  getAnalysesByEntryIds(entryIds: number[]): AnalysisRow[] {
    if (entryIds.length === 0) return [];
    const placeholders = entryIds.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT * FROM analyses WHERE entry_id IN (${placeholders}) ORDER BY created_at ASC`
    ).all(...entryIds) as AnalysisRow[];
  }

  getMetricsByDateRange(start: string, end: string): MetricsRow[] {
    return this.db.prepare(
      'SELECT * FROM metrics WHERE date >= ? AND date <= ? ORDER BY date ASC'
    ).all(start, end) as MetricsRow[];
  }

  getLastEntryDate(): string | null {
    const row = this.db.prepare(
      'SELECT date FROM entries ORDER BY created_at DESC LIMIT 1'
    ).get() as { date: string } | undefined;
    return row?.date ?? null;
  }

  hasEntryForDate(date: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM entries WHERE date = ? LIMIT 1'
    ).get(date);
    return !!row;
  }

  hasMetricsForDate(date: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM metrics WHERE date = ? LIMIT 1'
    ).get(date);
    return !!row;
  }

  insertThreadMessage(msg: {
    thread_id: number;
    role: 'user' | 'assistant';
    content: string;
    llm_provider?: string;
    llm_model?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO thread_messages (thread_id, role, content, llm_provider, llm_model)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      msg.thread_id,
      msg.role,
      msg.content,
      msg.llm_provider ?? null,
      msg.llm_model ?? null,
    );
    return result.lastInsertRowid as number;
  }

  getThreadMessages(threadId: number): ThreadMessageRow[] {
    return this.db.prepare(
      'SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC'
    ).all(threadId) as ThreadMessageRow[];
  }

  getFirstAssistantMessages(threadIds: number[]): Map<number, string> {
    if (threadIds.length === 0) return new Map();
    const placeholders = threadIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT thread_id, content FROM thread_messages
      WHERE thread_id IN (${placeholders}) AND role = 'assistant'
      ORDER BY created_at ASC
    `).all(...threadIds) as { thread_id: number; content: string }[];

    const map = new Map<number, string>();
    for (const row of rows) {
      if (!map.has(row.thread_id)) {
        map.set(row.thread_id, row.content);
      }
    }
    return map;
  }

  getReportsByDateRange(type: string, start: string, end: string): ReportRow[] {
    return this.db.prepare(
      'SELECT * FROM reports WHERE type = ? AND period_start >= ? AND period_end <= ? ORDER BY period_start ASC'
    ).all(type, start, end) as ReportRow[];
  }
}
