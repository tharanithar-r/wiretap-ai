import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

const dir = process.env.DB_DIR || path.join(process.cwd(), "data");
mkdirSync(dir, { recursive: true });
const db = new Database(path.join(dir, "elevatebox.db"));

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS callbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  when_text TEXT NOT NULL,
  when_at TEXT,
  to_number TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  room TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT UNIQUE NOT NULL,
  to_number TEXT,
  status TEXT DEFAULT 'started',
  language TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Schema change: callbacks gained an absolute when_at timestamp so the
// scheduler can compare times without re-resolving relative phrases each run.
// Testing phase — drop stale callbacks rather than migrate them.
const cbCols = db.prepare("PRAGMA table_info(callbacks)").all() as { name: string }[];
if (!cbCols.some((c) => c.name === "when_at")) {
  db.exec("ALTER TABLE callbacks ADD COLUMN when_at TEXT");
}

export function insertLead(level: string, notes: string) {
  return db.prepare("INSERT INTO leads (level, notes) VALUES (?, ?)").run(level, notes);
}

// Replace any pending callback already booked for this conversation (room),
// so a changed mind updates the existing row instead of duplicating it.
// `whenAt` is the callback time resolved ONCE at booking time (ISO 8601).
export function upsertCallback(whenText: string, to: string, whenAt: string | null, room?: string) {
  if (room) {
    const existing = db
      .prepare("SELECT id FROM callbacks WHERE room = ? AND done = 0 LIMIT 1")
      .get(room) as { id: number } | undefined;
    if (existing) {
      return db
        .prepare("UPDATE callbacks SET when_text = ?, when_at = ? WHERE id = ?")
        .run(whenText, whenAt, existing.id);
    }
  }
  return db
    .prepare("INSERT INTO callbacks (when_text, when_at, to_number, room) VALUES (?, ?, ?, ?)")
    .run(whenText, whenAt, to, room || null);
}

export interface CallbackRow {
  id: number;
  when_text: string;
  when_at: string | null;
  to_number: string;
  done: number;
  room: string | null;
}

export function pendingCallbacks(): CallbackRow[] {
  return db.prepare("SELECT * FROM callbacks WHERE done = 0").all() as CallbackRow[];
}

export function markCallbackDone(id: number) {
  return db.prepare("UPDATE callbacks SET done = 1 WHERE id = ?").run(id);
}

// ---- calls + events (dashboard timeline) ----

export interface CallRow {
  id: number;
  room: string;
  to_number: string | null;
  status: string;
  language: string | null;
  created_at: string;
  ended_at: string | null;
}

export function upsertCall(room: string, to?: string) {
  db.prepare(
    "INSERT INTO calls (room, to_number) VALUES (?, ?) ON CONFLICT(room) DO NOTHING",
  ).run(room, to || null);
}

export function updateCallStatus(room: string, status: string) {
  db.prepare(
    "UPDATE calls SET status = ?, ended_at = CASE WHEN ?='ended' THEN datetime('now') ELSE ended_at END WHERE room = ?",
  ).run(status, status, room);
}

export function updateCallLanguage(room: string, language: string) {
  db.prepare("UPDATE calls SET language = ? WHERE room = ?").run(language, room);
}

export function addEvent(room: string, kind: string, detail?: string) {
  db.prepare("INSERT INTO call_events (room, kind, detail) VALUES (?, ?, ?)").run(room, kind, detail || null);
}

export interface CallEventRow {
  id: number;
  room: string;
  kind: string;
  detail: string | null;
  created_at: string;
}

export function listCalls(limit = 20): (CallRow & { event_count: number })[] {
  return db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM call_events e WHERE e.room = c.room) AS event_count
       FROM calls c ORDER BY c.id DESC LIMIT ?`,
    )
    .all(limit) as (CallRow & { event_count: number })[];
}

export function listEvents(room: string): CallEventRow[] {
  return db.prepare("SELECT * FROM call_events WHERE room = ? ORDER BY id ASC").all(room) as CallEventRow[];
}

export function listLeads() {
  return db.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 50").all();
}

export default db;