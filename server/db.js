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
      asset_id TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT 'Main store',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS borrow_requests (
      id INTEGER PRIMARY KEY,
      equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE RESTRICT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      borrow_date TEXT NOT NULL,
      return_date TEXT NOT NULL,
      purpose TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
      returned_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS borrow_requests_user_id ON borrow_requests (user_id, id);
    -- ISO time with a Z: CURRENT_TIMESTAMP has no zone, and browsers would read it as local time.
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      reason TEXT,
      request_id INTEGER,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    -- id is assigned in insert order, so it orders newest first even if the clock steps back.
    DROP INDEX IF EXISTS notifications_user_created;
    CREATE INDEX IF NOT EXISTS notifications_user_id ON notifications (user_id, id);
  `);

  const equipmentColumns = new Set(db.prepare("PRAGMA table_info(equipment)").all().map((col) => col.name));
  if (!equipmentColumns.has("asset_id")) db.exec("ALTER TABLE equipment ADD COLUMN asset_id TEXT NOT NULL DEFAULT ''");
  if (!equipmentColumns.has("location")) db.exec("ALTER TABLE equipment ADD COLUMN location TEXT NOT NULL DEFAULT 'Main store'");
  db.exec(`
    UPDATE equipment SET asset_id = 'CG-' || printf('%04d', id) WHERE asset_id IS NULL OR asset_id = '';
    UPDATE equipment SET location = 'Main store' WHERE location IS NULL OR location = '';
    CREATE TRIGGER IF NOT EXISTS equipment_asset_id
    AFTER INSERT ON equipment
    WHEN NEW.asset_id = ''
    BEGIN
      UPDATE equipment SET asset_id = 'CG-' || printf('%04d', NEW.id) WHERE id = NEW.id;
    END;
  `);

  const requestColumns = new Set(db.prepare("PRAGMA table_info(borrow_requests)").all().map((col) => col.name));
  if (!requestColumns.has("decided_by")) db.exec("ALTER TABLE borrow_requests ADD COLUMN decided_by INTEGER");
  if (!requestColumns.has("decided_at")) db.exec("ALTER TABLE borrow_requests ADD COLUMN decided_at TEXT");
  if (!requestColumns.has("decision_reason")) db.exec("ALTER TABLE borrow_requests ADD COLUMN decision_reason TEXT");
  if (!requestColumns.has("returned_at")) db.exec("ALTER TABLE borrow_requests ADD COLUMN returned_at TEXT");

  const borrowRequestsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'borrow_requests'").get()?.sql ?? "";
  if (borrowRequestsSql && !borrowRequestsSql.includes("'cancelled'")) {
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec("BEGIN");
      db.exec(`
        CREATE TABLE borrow_requests_new (
          id INTEGER PRIMARY KEY,
          equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE RESTRICT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          borrow_date TEXT NOT NULL,
          return_date TEXT NOT NULL,
          purpose TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
          returned_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          decided_by INTEGER,
          decided_at TEXT,
          decision_reason TEXT
        );
        INSERT INTO borrow_requests_new
          (id, equipment_id, user_id, borrow_date, return_date, purpose, status, returned_at, created_at, decided_by, decided_at, decision_reason)
        SELECT
          id, equipment_id, user_id, borrow_date, return_date, purpose, status, returned_at, created_at, decided_by, decided_at, decision_reason
        FROM borrow_requests;
        DROP TABLE borrow_requests;
        ALTER TABLE borrow_requests_new RENAME TO borrow_requests;
        CREATE INDEX IF NOT EXISTS borrow_requests_user_id ON borrow_requests (user_id, id);
      `);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // SQLite already rolled back on its own; the original error matters more.
      }
      throw err;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }

  const notificationColumns = new Set(db.prepare("PRAGMA table_info(notifications)").all().map((col) => col.name));
  if (!notificationColumns.has("title")) db.exec("ALTER TABLE notifications ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  if (!notificationColumns.has("reason")) db.exec("ALTER TABLE notifications ADD COLUMN reason TEXT");
  if (!notificationColumns.has("request_id")) db.exec("ALTER TABLE notifications ADD COLUMN request_id INTEGER");

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
