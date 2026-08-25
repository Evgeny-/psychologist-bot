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
  local_time: string | null;
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
  emotions_json: string | null;
  triggers_json: string | null;
  wins_json: string | null;
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
  stress: number | null;
  productivity: number | null;
  routine: number | null;
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

export interface DailyMemoryRow {
  date: string;
  summary: string;
  source_entry_id: number | null;
  llm_provider: string | null;
  llm_model: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExperimentRow {
  id: number;
  text: string;
  success_criterion: string | null;
  target_count: number | null;
  progress_count: number;
  status: 'active' | 'done' | 'skipped';
  start_date: string;
  end_date: string | null;
  result_note: string | null;
  created_at: string;
}


export interface ContractRow {
  date: string;
  text: string | null;
  status: 'open' | 'done' | 'missed';
  resolved_entry_id: number | null;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface SlotRow {
  id: number;
  week_start: string;
  text: string;
  when_at: string | null;
  who: string | null;
  cost: string | null;
  status: 'open' | 'kept' | 'missed';
  result_note: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface LabelRow {
  id: number;
  entry_id: number | null;
  date: string;
  said_at: string | null;
  quote: string;
  verdict: 'yes' | 'no' | 'partly' | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface EntryEmbeddingRow {
  entry_id: number;
  model: string;
  vector: Buffer;
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
    local_time?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO entries (telegram_message_id, channel_post_id, date, type, raw_text, transcript, duration_seconds, local_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      entry.telegram_message_id,
      entry.channel_post_id ?? null,
      entry.date,
      entry.type,
      entry.raw_text ?? null,
      entry.transcript ?? null,
      entry.duration_seconds ?? null,
      entry.local_time ?? null,
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
    emotions_json?: string;
    triggers_json?: string;
    wins_json?: string;
    orbit_themes_json?: string;
    closing_question?: string;
    say_instead_json?: string;
    gratitude_count?: number;
    llm_provider?: string;
    llm_model?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO analyses (entry_id, analysis_text, sentiment, distortions_json, topics_json, action_items_json, emotions_json, triggers_json, wins_json, orbit_themes_json, closing_question, say_instead_json, gratitude_count, llm_provider, llm_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      analysis.entry_id,
      analysis.analysis_text,
      analysis.sentiment ?? null,
      analysis.distortions_json ?? null,
      analysis.topics_json ?? null,
      analysis.action_items_json ?? null,
      analysis.emotions_json ?? null,
      analysis.triggers_json ?? null,
      analysis.wins_json ?? null,
      analysis.orbit_themes_json ?? null,
      analysis.closing_question ?? null,
      analysis.say_instead_json ?? null,
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
    stress?: number;
    productivity?: number;
    routine?: number;
    custom_json?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO metrics (entry_id, date, mood, anxiety, stress, productivity, routine, custom_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      metrics.entry_id ?? null,
      metrics.date,
      metrics.mood ?? null,
      metrics.anxiety ?? null,
      metrics.stress ?? null,
      metrics.productivity ?? null,
      metrics.routine ?? null,
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

  getEntryById(id: number): EntryRow | undefined {
    return this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as EntryRow | undefined;
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

  getAllThreadMessages(threadIds: number[]): Map<number, ThreadMessageRow[]> {
    if (threadIds.length === 0) return new Map();
    const placeholders = threadIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT * FROM thread_messages
      WHERE thread_id IN (${placeholders})
      ORDER BY created_at ASC
    `).all(...threadIds) as ThreadMessageRow[];

    const map = new Map<number, ThreadMessageRow[]>();
    for (const row of rows) {
      const existing = map.get(row.thread_id);
      if (existing) {
        existing.push(row);
      } else {
        map.set(row.thread_id, [row]);
      }
    }
    return map;
  }

  getEarlierEntriesForDate(date: string, excludeEntryId: number): Array<{ transcript: string | null; raw_text: string | null; analysis_text: string | null }> {
    return this.db.prepare(`
      SELECT e.transcript, e.raw_text,
        (SELECT a.analysis_text FROM analyses a WHERE a.entry_id = e.id ORDER BY a.created_at ASC LIMIT 1) as analysis_text
      FROM entries e
      WHERE e.date = ? AND e.id < ?
      ORDER BY e.created_at ASC
    `).all(date, excludeEntryId) as Array<{ transcript: string | null; raw_text: string | null; analysis_text: string | null }>;
  }

  getReportsByDateRange(type: string, start: string, end: string): ReportRow[] {
    return this.db.prepare(
      'SELECT * FROM reports WHERE type = ? AND period_start >= ? AND period_end <= ? ORDER BY period_start ASC'
    ).all(type, start, end) as ReportRow[];
  }

  hasReportForPeriod(type: string, periodStart: string, periodEnd: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM reports WHERE type = ? AND period_start = ? AND period_end = ? LIMIT 1'
    ).get(type, periodStart, periodEnd);
    return !!row;
  }

  /** Count consecutive days with entries ending at `today` */
  getStreak(today?: string): number {
    const rows = this.db.prepare(
      'SELECT DISTINCT date FROM entries ORDER BY date DESC'
    ).all() as { date: string }[];

    if (rows.length === 0) return 0;

    let streak = 0;
    const startDate = today ? new Date(today + 'T00:00:00') : new Date(rows[0].date + 'T00:00:00');
    const dateSet = new Set(rows.map((r) => r.date));

    for (let i = 0; i < 365; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      if (dateSet.has(ds)) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }

  /** Total number of entries */
  getTotalEntries(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM entries').get() as { cnt: number };
    return row.cnt;
  }

  /** Average metrics for a date range */
  getAverageMetrics(start: string, end: string): { avgMood: number | null; avgAnxiety: number | null; avgStress: number | null; avgProductivity: number | null; avgRoutine: number | null; count: number } {
    const row = this.db.prepare(`
      SELECT AVG(mood) as avgMood, AVG(anxiety) as avgAnxiety, AVG(stress) as avgStress, AVG(productivity) as avgProductivity, AVG(routine) as avgRoutine, COUNT(*) as count
      FROM metrics WHERE date >= ? AND date <= ? AND (mood IS NOT NULL OR anxiety IS NOT NULL OR stress IS NOT NULL OR productivity IS NOT NULL OR routine IS NOT NULL)
    `).get(start, end) as { avgMood: number | null; avgAnxiety: number | null; avgStress: number | null; avgProductivity: number | null; avgRoutine: number | null; count: number };
    return row;
  }

  /** Get all entries with their metrics for CSV export */
  getExportData(start?: string, end?: string): Array<{
    date: string;
    local_time: string | null;
    type: string;
    text: string | null;
    mood: number | null;
    anxiety: number | null;
    stress: number | null;
    productivity: number | null;
    routine: number | null;
  }> {
    let sql = `
      SELECT e.date, e.local_time, e.type,
        COALESCE(e.transcript, e.raw_text) as text,
        m.mood, m.anxiety, m.stress, m.productivity, m.routine
      FROM entries e
      LEFT JOIN metrics m ON m.entry_id = e.id
    `;
    const params: string[] = [];
    if (start && end) {
      sql += ' WHERE e.date >= ? AND e.date <= ?';
      params.push(start, end);
    }
    sql += ' ORDER BY e.date ASC, e.created_at ASC';
    return this.db.prepare(sql).all(...params) as Array<{
      date: string; local_time: string | null; type: string; text: string | null;
      mood: number | null; anxiety: number | null; stress: number | null; productivity: number | null; routine: number | null;
    }>;
  }

  getMemory(): string {
    const row = this.db.prepare('SELECT content FROM memory WHERE id = 1').get() as { content: string } | undefined;
    return row?.content ?? '';
  }

  setMemory(content: string): void {
    this.db.prepare('UPDATE memory SET content = ?, updated_at = datetime(\'now\') WHERE id = 1').run(content);
  }

  getDailyMemoryByDateRange(start: string, end: string): DailyMemoryRow[] {
    return this.db.prepare(
      'SELECT * FROM daily_memory WHERE date >= ? AND date <= ? ORDER BY date ASC'
    ).all(start, end) as DailyMemoryRow[];
  }

  upsertDailyMemory(memory: {
    date: string;
    summary: string;
    source_entry_id?: number;
    llm_provider?: string;
    llm_model?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO daily_memory (date, summary, source_entry_id, llm_provider, llm_model)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        summary = excluded.summary,
        source_entry_id = excluded.source_entry_id,
        llm_provider = excluded.llm_provider,
        llm_model = excluded.llm_model,
        updated_at = datetime('now')
    `).run(
      memory.date,
      memory.summary,
      memory.source_entry_id ?? null,
      memory.llm_provider ?? null,
      memory.llm_model ?? null,
    );
  }

  // --- Experiments (retired format, kept read-only for history) ---
  // Weekly behavioural experiments were replaced by the daily contract and the weekly slot:
  // over four months the format produced one counted rep out of twenty opportunities. Only
  // the two calls needed to retire a still-open experiment remain.

  getActiveExperiment(): ExperimentRow | null {
    const row = this.db.prepare(
      "SELECT * FROM experiments WHERE status = 'active' ORDER BY start_date DESC, id DESC LIMIT 1"
    ).get() as ExperimentRow | undefined;
    return row ?? null;
  }

  closeExperiment(id: number, close: {
    status: 'done' | 'skipped';
    result_note?: string;
    end_date: string;
  }): void {
    this.db.prepare(
      'UPDATE experiments SET status = ?, result_note = ?, end_date = ? WHERE id = ?'
    ).run(close.status, close.result_note ?? null, close.end_date, id);
  }

  // --- Contracts: one binary "did you make one live contact" per day ---

  getContract(date: string): ContractRow | null {
    const row = this.db.prepare('SELECT * FROM contracts WHERE date = ?').get(date) as ContractRow | undefined;
    return row ?? null;
  }

  /** Opens today's contract if absent; never resets one already resolved. */
  openContract(date: string): void {
    this.db.prepare("INSERT OR IGNORE INTO contracts (date, status) VALUES (?, 'open')").run(date);
  }

  /** Records what he named as the contract, without touching its status. */
  setContractText(date: string, text: string): void {
    this.db.prepare('UPDATE contracts SET text = ? WHERE date = ?').run(text, date);
  }

  resolveContract(date: string, resolution: {
    status: 'done' | 'missed';
    note?: string;
    entry_id?: number;
  }): void {
    this.db.prepare(`
      UPDATE contracts
      SET status = ?, note = COALESCE(?, note), resolved_entry_id = COALESCE(?, resolved_entry_id),
          resolved_at = datetime('now')
      WHERE date = ?
    `).run(resolution.status, resolution.note ?? null, resolution.entry_id ?? null, date);
  }

  /** Auto-close days that were never answered, so the streak reflects reality. */
  markStaleContractsMissed(beforeDate: string): number {
    const result = this.db.prepare(
      "UPDATE contracts SET status = 'missed', resolved_at = datetime('now') WHERE status = 'open' AND date < ?"
    ).run(beforeDate);
    return result.changes;
  }

  /** Per-day contract outcomes: the weekly report asks which days worked, not just how many. */
  getContractsByRange(start: string, end: string): Array<{ date: string; status: string; text: string | null; note: string | null }> {
    return this.db.prepare(
      'SELECT date, status, text, note FROM contracts WHERE date BETWEEN ? AND ? ORDER BY date ASC'
    ).all(start, end) as Array<{ date: string; status: string; text: string | null; note: string | null }>;
  }

  getContractStats(start: string, end: string): { done: number; missed: number; open: number } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) as missed,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open
      FROM contracts WHERE date BETWEEN ? AND ?
    `).get(start, end) as { done: number | null; missed: number | null; open: number | null };
    return { done: row?.done ?? 0, missed: row?.missed ?? 0, open: row?.open ?? 0 };
  }

  // --- Slots: commitments that already cost a date, money or another person ---

  getOpenSlot(): SlotRow | null {
    const row = this.db.prepare(
      "SELECT * FROM slots WHERE status = 'open' ORDER BY week_start DESC, id DESC LIMIT 1"
    ).get() as SlotRow | undefined;
    return row ?? null;
  }

  insertSlot(slot: {
    week_start: string;
    text: string;
    when_at?: string;
    who?: string;
    cost?: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO slots (week_start, text, when_at, who, cost)
      VALUES (?, ?, ?, ?, ?)
    `).run(slot.week_start, slot.text, slot.when_at ?? null, slot.who ?? null, slot.cost ?? null);
    return result.lastInsertRowid as number;
  }

  closeSlot(id: number, close: { status: 'kept' | 'missed'; result_note?: string }): void {
    this.db.prepare(
      "UPDATE slots SET status = ?, result_note = ?, closed_at = datetime('now') WHERE id = ?"
    ).run(close.status, close.result_note ?? null, id);
  }

  getRecentSlots(limit: number): SlotRow[] {
    return this.db.prepare('SELECT * FROM slots ORDER BY week_start DESC, id DESC LIMIT ?').all(limit) as SlotRow[];
  }

  // --- Labels: verbatim verdicts held over for a next-morning review ---

  insertLabel(label: {
    entry_id?: number;
    date: string;
    said_at?: string;
    quote: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO labels (entry_id, date, said_at, quote)
      VALUES (?, ?, ?, ?)
    `).run(label.entry_id ?? null, label.date, label.said_at ?? null, label.quote);
    return result.lastInsertRowid as number;
  }

  /** The label to put in front of him tomorrow morning: latest unreviewed one for a date. */
  getLabelForReview(date: string): LabelRow | null {
    const row = this.db.prepare(
      'SELECT * FROM labels WHERE date = ? AND verdict IS NULL ORDER BY id DESC LIMIT 1'
    ).get(date) as LabelRow | undefined;
    return row ?? null;
  }

  reviewLabel(id: number, verdict: 'yes' | 'no' | 'partly'): void {
    this.db.prepare("UPDATE labels SET verdict = ?, reviewed_at = datetime('now') WHERE id = ?").run(verdict, id);
  }

  /** Drop unanswered labels once they are too old to review honestly. */
  expireLabels(beforeDate: string): number {
    const result = this.db.prepare('DELETE FROM labels WHERE verdict IS NULL AND date < ?').run(beforeDate);
    return result.changes;
  }

  /** How many evening verdicts survived the morning — his own counter, not an argument. */
  getLabelReviewStats(): { yes: number; no: number; partly: number } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN verdict = 'yes' THEN 1 ELSE 0 END) as yes,
        SUM(CASE WHEN verdict = 'no' THEN 1 ELSE 0 END) as no,
        SUM(CASE WHEN verdict = 'partly' THEN 1 ELSE 0 END) as partly
      FROM labels
    `).get() as { yes: number | null; no: number | null; partly: number | null };
    return { yes: row?.yes ?? 0, no: row?.no ?? 0, partly: row?.partly ?? 0 };
  }

  // --- Credits: externally sourced evidence that the work landed ---

  insertCredit(credit: { entry_id?: number; date: string; text: string }): number {
    const result = this.db.prepare('INSERT INTO credits (entry_id, date, text) VALUES (?, ?, ?)')
      .run(credit.entry_id ?? null, credit.date, credit.text);
    return result.lastInsertRowid as number;
  }

  getRecentCredits(limit: number): Array<{ date: string; text: string }> {
    return this.db.prepare('SELECT date, text FROM credits ORDER BY date DESC, id DESC LIMIT ?')
      .all(limit) as Array<{ date: string; text: string }>;
  }

  getCreditsByDateRange(start: string, end: string): Array<{ date: string; text: string }> {
    return this.db.prepare('SELECT date, text FROM credits WHERE date BETWEEN ? AND ? ORDER BY date ASC, id ASC')
      .all(start, end) as Array<{ date: string; text: string }>;
  }

  /**
   * Recent say-instead lines, so the prompt can avoid re-offering one.
   *
   * The same alternative sentence handed back every evening stops being a sentence and becomes
   * wallpaper — the exact failure the morning brief died of.
   */
  getRecentSayInstead(limit: number): Array<{ quote: string; say: string }> {
    const rows = this.db.prepare(`
      SELECT say_instead_json AS j FROM analyses
      WHERE say_instead_json IS NOT NULL AND say_instead_json != ''
        AND id IN (SELECT MIN(id) FROM analyses GROUP BY entry_id)
      ORDER BY id DESC LIMIT ?
    `).all(limit) as Array<{ j: string }>;
    const out: Array<{ quote: string; say: string }> = [];
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.j);
        if (parsed && typeof parsed.quote === 'string' && typeof parsed.say === 'string') {
          out.push({ quote: parsed.quote, say: parsed.say });
        }
      } catch { /* malformed row, skip */ }
    }
    return out;
  }

  /** Recently asked closing questions, so the next prompt can refuse to repeat them. */
  getRecentClosingQuestions(limit: number): string[] {
    const rows = this.db.prepare(`
      SELECT a.closing_question as q
      FROM analyses a
      WHERE a.closing_question IS NOT NULL AND a.closing_question != ''
        AND a.id IN (SELECT MIN(id) FROM analyses GROUP BY entry_id)
      ORDER BY a.id DESC LIMIT ?
    `).all(limit) as Array<{ q: string }>;
    return rows.map((r) => r.q);
  }

  // --- Morning credits: the credit-for-yesterday that replaced the morning task ---

  getMorningCredit(date: string): { date: string; source_date: string; quote: string | null; verdict: string | null } | null {
    const row = this.db.prepare('SELECT date, source_date, quote, verdict FROM morning_credits WHERE date = ?').get(date) as
      { date: string; source_date: string; quote: string | null; verdict: string | null } | undefined;
    return row ?? null;
  }

  insertMorningCredit(credit: {
    date: string;
    source_date: string;
    quote?: string;
    skill?: string;
    counter?: string;
    message_id?: number;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO morning_credits (date, source_date, quote, skill, counter, message_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(credit.date, credit.source_date, credit.quote ?? null, credit.skill ?? null,
           credit.counter ?? null, credit.message_id ?? null);
  }

  answerMorningCredit(date: string, verdict: 'yes' | 'no' | 'unsure'): void {
    this.db.prepare("UPDATE morning_credits SET verdict = ?, answered_at = datetime('now') WHERE date = ?").run(verdict, date);
  }

  /** How many credits he confirmed, disputed or could not recall — his own counter, not an argument. */
  getMorningCreditStats(): { yes: number; no: number; unsure: number; unanswered: number } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN verdict = 'yes' THEN 1 ELSE 0 END) as yes,
        SUM(CASE WHEN verdict = 'no' THEN 1 ELSE 0 END) as no,
        SUM(CASE WHEN verdict = 'unsure' THEN 1 ELSE 0 END) as unsure,
        SUM(CASE WHEN verdict IS NULL THEN 1 ELSE 0 END) as unanswered
      FROM morning_credits
    `).get() as { yes: number | null; no: number | null; unsure: number | null; unanswered: number | null };
    return { yes: row?.yes ?? 0, no: row?.no ?? 0, unsure: row?.unsure ?? 0, unanswered: row?.unanswered ?? 0 };
  }

  /** What was already credited, so a morning does not credit the same walk three times running. */
  getRecentMorningCredits(limit: number): Array<{ date: string; quote: string; skill: string; verdict: string | null }> {
    return this.db.prepare(`
      SELECT date, quote, skill, verdict FROM morning_credits
      WHERE quote IS NOT NULL AND skill IS NOT NULL
      ORDER BY date DESC LIMIT ?
    `).all(limit) as Array<{ date: string; quote: string; skill: string; verdict: string | null }>;
  }

  /** Credits he confirmed with a tap — the only ones a report may repeat back as fact. */
  getConfirmedMorningCredits(start: string, end: string): Array<{ date: string; quote: string; skill: string }> {
    return this.db.prepare(`
      SELECT date, quote, skill FROM morning_credits
      WHERE verdict = 'yes' AND quote IS NOT NULL AND skill IS NOT NULL AND date BETWEEN ? AND ?
      ORDER BY date ASC
    `).all(start, end) as Array<{ date: string; quote: string; skill: string }>;
  }

  getMorningCreditStatsByRange(start: string, end: string): { yes: number; no: number; unsure: number; unanswered: number } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN verdict = 'yes' THEN 1 ELSE 0 END) as yes,
        SUM(CASE WHEN verdict = 'no' THEN 1 ELSE 0 END) as no,
        SUM(CASE WHEN verdict = 'unsure' THEN 1 ELSE 0 END) as unsure,
        SUM(CASE WHEN verdict IS NULL THEN 1 ELSE 0 END) as unanswered
      FROM morning_credits WHERE date BETWEEN ? AND ?
    `).get(start, end) as { yes: number | null; no: number | null; unsure: number | null; unanswered: number | null };
    return { yes: row?.yes ?? 0, no: row?.no ?? 0, unsure: row?.unsure ?? 0, unanswered: row?.unanswered ?? 0 };
  }

  /** Wins recorded by the evening analysis — the raw material a morning credit is built from. */
  getWinsForDate(date: string): string[] {
    const rows = this.db.prepare(`
      SELECT a.wins_json FROM analyses a JOIN entries e ON e.id = a.entry_id
      WHERE e.date = ? AND a.wins_json IS NOT NULL
        AND a.id IN (SELECT MIN(id) FROM analyses GROUP BY entry_id)
      ORDER BY a.id
    `).all(date) as Array<{ wins_json: string }>;
    const out: string[] = [];
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.wins_json);
        if (Array.isArray(parsed)) out.push(...parsed.filter((w): w is string => typeof w === 'string'));
      } catch { /* malformed row, skip */ }
    }
    return out;
  }

  // --- Vetoes: standing instructions about what never to raise again ---

  insertVeto(text: string): number {
    const result = this.db.prepare('INSERT INTO vetoes (text) VALUES (?)').run(text);
    return result.lastInsertRowid as number;
  }

  getVetoes(): Array<{ id: number; text: string }> {
    return this.db.prepare('SELECT id, text FROM vetoes ORDER BY id ASC').all() as Array<{ id: number; text: string }>;
  }

  deleteVeto(id: number): boolean {
    return this.db.prepare('DELETE FROM vetoes WHERE id = ?').run(id).changes > 0;
  }

  // --- Pattern statistics ---

  /**
   * All analyses that recorded distortions, for pattern counters.
   * One row per entry (the first-saved analysis): in compare mode every provider
   * inserts its own analyses row for the same entry, and counting all of them
   * would inflate pattern statistics ~2x.
   */
  getAnalysesWithDistortions(): Array<{ id: number; entry_id: number; distortions_json: string; created_at: string }> {
    return this.db.prepare(`
      SELECT a.id, a.entry_id, a.distortions_json,
        COALESCE(e.date, substr(a.created_at, 1, 10)) as created_at
      FROM analyses a
      LEFT JOIN entries e ON e.id = a.entry_id
      WHERE a.distortions_json IS NOT NULL AND a.distortions_json != ''
        AND a.id IN (SELECT MIN(id) FROM analyses GROUP BY entry_id)
      ORDER BY a.created_at ASC
    `).all() as Array<{ id: number; entry_id: number; distortions_json: string; created_at: string }>;
  }

  /**
   * Orbit-theme tags with entry dates since a given date (inclusive), one row per
   * (entry, theme). First-saved analysis per entry — same compare-mode dedup as above.
   * Feeds the "active orbits" context block: counting repeats deterministically.
   */
  getOrbitActivitySince(sinceDate: string, excludeEntryId?: number): Array<{ date: string; theme: string }> {
    return this.db.prepare(`
      SELECT e.date as date, je.value as theme
      FROM analyses a
      JOIN entries e ON e.id = a.entry_id, json_each(a.orbit_themes_json) je
      WHERE e.date >= ? AND a.entry_id != ? AND a.orbit_themes_json IS NOT NULL AND a.orbit_themes_json != ''
        AND a.id IN (SELECT MIN(id) FROM analyses GROUP BY entry_id)
      ORDER BY e.date ASC
    `).all(sinceDate, excludeEntryId ?? -1) as Array<{ date: string; theme: string }>;
  }

  /** Per-user historical notes for orbit themes (seeded manually, may be empty). */
  getOrbitMetaNotes(): Map<string, string> {
    const map = new Map<string, string>();
    try {
      const rows = this.db.prepare('SELECT theme_key, archive_note FROM orbit_meta').all() as Array<{ theme_key: string; archive_note: string }>;
      for (const row of rows) {
        if (row.archive_note?.trim()) map.set(row.theme_key, row.archive_note.trim());
      }
    } catch { /* table may not exist in older DBs */ }
    return map;
  }

  /**
   * Flattened action items from entries on a given date.
   * One analyses row per entry (first-saved) — in compare mode each provider stores
   * its own row, and flattening all of them duplicates the same intention.
   */
  getActionItemsForDate(date: string): string[] {
    const rows = this.db.prepare(`
      SELECT a.action_items_json
      FROM analyses a
      JOIN entries e ON e.id = a.entry_id
      WHERE e.date = ? AND a.action_items_json IS NOT NULL AND a.action_items_json != ''
        AND a.id IN (SELECT MIN(id) FROM analyses GROUP BY entry_id)
      ORDER BY a.created_at ASC
    `).all(date) as Array<{ action_items_json: string }>;

    const items: string[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.action_items_json);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'string' && item.trim()) items.push(item.trim());
          }
        }
      } catch { /* skip malformed */ }
    }
    return items;
  }

  // --- Entry embeddings (semantic similarity) ---

  upsertEntryEmbedding(embedding: { entry_id: number; model: string; vector: Buffer }): void {
    this.db.prepare(`
      INSERT INTO entry_embeddings (entry_id, model, vector)
      VALUES (?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        model = excluded.model,
        vector = excluded.vector,
        created_at = datetime('now')
    `).run(embedding.entry_id, embedding.model, embedding.vector);
  }

  getAllEntryEmbeddings(): EntryEmbeddingRow[] {
    return this.db.prepare(
      'SELECT entry_id, model, vector FROM entry_embeddings'
    ).all() as EntryEmbeddingRow[];
  }

  getEntriesWithoutEmbeddings(limit: number): Array<{ id: number; date: string; text: string }> {
    return this.db.prepare(`
      SELECT e.id, e.date, COALESCE(e.transcript, e.raw_text) as text
      FROM entries e
      LEFT JOIN entry_embeddings ee ON ee.entry_id = e.id
      WHERE ee.entry_id IS NULL
        AND COALESCE(e.transcript, e.raw_text) IS NOT NULL
        AND TRIM(COALESCE(e.transcript, e.raw_text)) != ''
      ORDER BY e.id ASC
      LIMIT ?
    `).all(limit) as Array<{ id: number; date: string; text: string }>;
  }

  /** Date + text snippet for a set of entry ids (for similarity rendering). */
  getEntrySnippetsByIds(ids: number[]): Array<{ id: number; date: string; text: string | null }> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT id, date, COALESCE(transcript, raw_text) as text
      FROM entries WHERE id IN (${placeholders})
    `).all(...ids) as Array<{ id: number; date: string; text: string | null }>;
  }

  /** daily_memory summaries keyed by date, for the given dates. */
  getDailyMemorySummariesByDates(dates: string[]): Map<string, string> {
    const map = new Map<string, string>();
    if (dates.length === 0) return map;
    const placeholders = dates.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT date, summary FROM daily_memory WHERE date IN (${placeholders})`
    ).all(...dates) as Array<{ date: string; summary: string }>;
    for (const row of rows) map.set(row.date, row.summary);
    return map;
  }
}
