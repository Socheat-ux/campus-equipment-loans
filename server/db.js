import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// shortcut: node:sqlite is still flagged experimental in Node 22 to 24, switch to Postgres if the pilot needs several servers.
export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('student', 'faculty', 'admin')),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    -- ISO time with a Z: CURRENT_TIMESTAMP has no zone, and browsers would read it as local time.
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      reason TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    -- id is assigned in insert order, so it orders newest first even if the clock steps back.
    DROP INDEX IF EXISTS notifications_user_created;
    CREATE INDEX IF NOT EXISTS notifications_user_id ON notifications (user_id, id);
  `);
  return db;
}

// Runs fn as one transaction: all of its writes land, or none do.
// fn must be synchronous. Code after an await would run outside the transaction, so a promise is refused.
export function withTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    if (typeof result?.then === "function") {
      result.then(null, () => {}); // already refused below; keep a late rejection from crashing the process
      throw new TypeError("withTransaction needs a synchronous function.");
    }
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite already rolled back on its own; the original error matters more.
    }
    throw err;
  }
}
