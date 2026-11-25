import { test, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { hashPassword } from "./auth.js";
import { copySqliteToPostgres } from "./copy-sqlite.js";

const script = fileURLToPath(new URL("./copy-sqlite.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "copy-sqlite-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// The final SQLite schema: what openDb in commit 3b3b4ad leaves behind.
const SQLITE_SCHEMA = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'faculty', 'admin')),
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
  );
  CREATE TABLE equipment (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    available INTEGER CHECK (available >= 0 AND available <= quantity),
    asset_id TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT 'Main store',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE borrow_requests (
    id INTEGER PRIMARY KEY, equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE RESTRICT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    borrow_date TEXT NOT NULL, return_date TEXT NOT NULL, purpose TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
    returned_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    decided_by INTEGER, decided_at TEXT, decision_reason TEXT
  );
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', message TEXT NOT NULL, reason TEXT, request_id INTEGER,
    read_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;
const TABLES = ["users", "sessions", "equipment", "borrow_requests", "notifications"];
const keyOf = (table) => (table === "sessions" ? "token_hash" : "id");

let fileCount = 0;
// Builds a throwaway SQLite file. Checks and foreign keys are off while filling, so tests can plant rows an old file could hold.
function buildSqlite(fill, schema = SQLITE_SCHEMA) {
  const path = join(dir, `old-${++fileCount}.db`);
  const lite = new DatabaseSync(path);
  lite.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;");
  lite.exec(schema);
  fill?.(lite);
  lite.close();
  return path;
}
function put(lite, table, row) {
  const keys = Object.keys(row);
  lite.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...Object.values(row));
}
const user = (id, email = `user${id}.test@student.cadt.edu.kh`, role = "student") =>
  ({ id, email, full_name: `User ${id}`, role, password_hash: "x", created_at: "2025-01-01 00:00:00" });
const item = (id, quantity, available, extra = {}) =>
  ({ id, name: `Item ${id}`, category: "Laptop", quantity, available, asset_id: `CG-${String(id).padStart(4, "0")}`, ...extra });
const loan = (id, equipment_id, user_id, status, extra = {}) =>
  ({ id, equipment_id, user_id, borrow_date: "2025-03-01", return_date: "2025-03-05", purpose: "class", status, ...extra });
const note = (id, user_id, type, request_id) =>
  ({ id, user_id, type, title: type, message: `message ${id}`, request_id, created_at: `2025-03-01T00:00:${String(id % 60).padStart(2, "0")}.000Z` });

const plain = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]));
function sqliteRows(path, table) {
  const lite = new DatabaseSync(path, { readOnly: true });
  try {
    return lite.prepare(`SELECT * FROM ${table} ORDER BY ${keyOf(table)}`).all().map(plain);
  } finally {
    lite.close();
  }
}
const pgRows = async (db, table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY ${keyOf(table)}`).all()).map(plain);
const pgDump = async (db) => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await pgRows(db, t)])));
const total = async (db) => (await Promise.all(TABLES.map(async (t) => (await db.prepare(`SELECT COUNT(*)::int AS n FROM ${t}`).get()).n))).reduce((a, b) => a + b, 0);
const fileState = (path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs });
function assertUntouched(before, path) {
  const after = fileState(path);
  assert.ok(before.bytes.equals(after.bytes), "the SQLite file bytes changed");
  assert.equal(after.mtime, before.mtime);
}
async function target(t) {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  return db;
}
const copiedOf = (counts) => Object.fromEntries(Object.entries(counts).map(([t, c]) => [t, c.copied]));

test("copy keeps total, shelf and loans for every item, and a second run changes nothing", async (t) => {
  const path = buildSqlite((lite) => {
    for (const u of [user(1, "admin.test@cadt.edu.kh", "admin"), user(2), user(3), user(4)]) put(lite, "users", u);
    put(lite, "equipment", item(1, 5, 3));
    put(lite, "equipment", item(2, 2, 2));
    put(lite, "equipment", item(3, 4, 1));
    put(lite, "borrow_requests", loan(1, 1, 2, "approved"));
    put(lite, "borrow_requests", loan(2, 1, 3, "approved"));
    for (const [id, u] of [[3, 2], [4, 3], [5, 4]]) put(lite, "borrow_requests", loan(id, 3, u, "approved"));
    put(lite, "borrow_requests", loan(6, 3, 2, "pending"));
    put(lite, "borrow_requests", loan(7, 3, 3, "returned", { returned_at: "2025-03-04T10:00:00.000Z" }));
    put(lite, "borrow_requests", loan(8, 2, 4, "rejected", { decided_by: 1, decided_at: "2025-03-01", decision_reason: "booked" }));
  });
  const before = fileState(path);
  const db = await target(t);

  const first = await copySqliteToPostgres(path, db);
  assert.deepEqual(copiedOf(first), { users: 4, sessions: 0, equipment: 3, borrow_requests: 8, notifications: 0 });
  for (const table of TABLES) assert.deepEqual(await pgRows(db, table), sqliteRows(path, table), table);
  const stock = await db.prepare(
    `SELECT e.id, e.quantity, e.available,
            (SELECT COUNT(*)::int FROM borrow_requests r WHERE r.equipment_id = e.id AND r.status = 'approved') AS loans
     FROM equipment e ORDER BY e.id`,
  ).all();
  assert.deepEqual(stock.map((s) => [s.id, s.quantity, s.available, s.loans]), [[1, 5, 3, 2], [2, 2, 2, 0], [3, 4, 1, 3]]);

  const dump = await pgDump(db);
  const second = await copySqliteToPostgres(path, db);
  assert.deepEqual(copiedOf(second), { users: 0, sessions: 0, equipment: 0, borrow_requests: 0, notifications: 0 });
  assert.deepEqual(second.borrow_requests, { copied: 0, skipped: 8, converted: 0 });
  assert.deepEqual(await pgDump(db), dump);
  assertUntouched(before, path);
});

test("copy keeps approved loans, overdue included, and stock matches them", async (t) => {
  const path = buildSqlite((lite) => {
    for (const u of [user(1), user(2), user(3)]) put(lite, "users", u);
    put(lite, "equipment", item(1, 3, null)); // shelf unknown: filled from the two approved loans
    put(lite, "equipment", item(2, 2, 2));
    put(lite, "equipment", item(3, 1, 0));
    put(lite, "borrow_requests", loan(1, 1, 1, "approved", { borrow_date: "2020-01-01", return_date: "2020-01-05" })); // overdue
    put(lite, "borrow_requests", loan(2, 1, 2, "approved", { borrow_date: "2999-01-01", return_date: "2999-01-05" }));
    put(lite, "borrow_requests", loan(3, 1, 3, "pending"));
    put(lite, "borrow_requests", loan(4, 3, 1, "approved", { borrow_date: "2020-02-01", return_date: "2020-02-05" })); // overdue
    put(lite, "borrow_requests", loan(5, 2, 2, "returned"));
    put(lite, "borrow_requests", loan(6, 2, 3, "cancelled"));
  });
  const db = await target(t);
  await copySqliteToPostgres(path, db);

  const approved = await db.prepare("SELECT id, return_date FROM borrow_requests WHERE status = 'approved' ORDER BY id").all();
  assert.deepEqual(approved.map((r) => [r.id, r.return_date]), [[1, "2020-01-05"], [2, "2999-01-05"], [4, "2020-02-05"]]);
  const mismatched = await db.prepare(
    `SELECT e.id FROM equipment e
     WHERE e.available <> e.quantity - (SELECT COUNT(*)::int FROM borrow_requests r WHERE r.equipment_id = e.id AND r.status = 'approved')`,
  ).all();
  assert.deepEqual(mismatched, []);
  assert.equal((await db.prepare("SELECT available FROM equipment WHERE id = 1").get()).available, 1);
});

test("a copy that fails part way leaves Postgres empty, and works once the bad row is fixed", async (t) => {
  const path = buildSqlite((lite) => {
    put(lite, "users", user(1));
    put(lite, "users", user(2));
    put(lite, "sessions", { token_hash: "a".repeat(64), user_id: 1, expires_at: 4102444800000 });
    put(lite, "equipment", item(1, 3, 3));
    put(lite, "equipment", item(2, 2, 9)); // shelf above total: Postgres refuses it
    put(lite, "equipment", item(3, 1, 1));
    put(lite, "borrow_requests", loan(1, 1, 1, "approved"));
  });
  const db = await target(t);

  await assert.rejects(copySqliteToPostgres(path, db), /equipment id 2/);
  assert.equal(await total(db), 0);

  const lite = new DatabaseSync(path);
  lite.exec("UPDATE equipment SET available = 2 WHERE id = 2");
  lite.close();
  const counts = await copySqliteToPostgres(path, db);
  assert.deepEqual(copiedOf(counts), { users: 2, sessions: 1, equipment: 3, borrow_requests: 1, notifications: 0 });
  assert.equal((await db.prepare("SELECT available FROM equipment WHERE id = 2").get()).available, 2);
});

test("a loan for a missing item makes the copy fail naming the table and id, and writes nothing", async (t) => {
  const path = buildSqlite((lite) => {
    put(lite, "users", user(1));
    put(lite, "equipment", item(1, 1, 1));
    put(lite, "borrow_requests", loan(1, 1, 1, "returned"));
    put(lite, "borrow_requests", loan(2, 77, 1, "returned"));
  });
  const db = await target(t);
  await assert.rejects(copySqliteToPostgres(path, db), /borrow_requests id 2/);
  assert.equal(await total(db), 0);
});

test("copy fills only NULL shelves, floors at 0, and leaves a non-NULL shelf alone", async (t) => {
  const path = buildSqlite((lite) => {
    for (const u of [user(1), user(2), user(3)]) put(lite, "users", u);
    put(lite, "equipment", item(1, 5, null)); // two approved -> 3
    put(lite, "equipment", item(2, 1, null)); // three approved -> floored at 0
    put(lite, "equipment", item(3, 4, 4)); // one approved, but the stored 4 is kept
    put(lite, "equipment", item(4, 2, null)); // no loans -> 2
    put(lite, "equipment", item(5, 6, null)); // only pending, returned, rejected -> 6
    put(lite, "equipment", item(6, 3, 0)); // an explicit 0 is not NULL
    put(lite, "borrow_requests", loan(1, 1, 1, "approved"));
    put(lite, "borrow_requests", loan(2, 1, 2, "approved"));
    put(lite, "borrow_requests", loan(3, 2, 1, "approved"));
    put(lite, "borrow_requests", loan(4, 2, 2, "approved"));
    put(lite, "borrow_requests", loan(5, 2, 3, "approved"));
    put(lite, "borrow_requests", loan(6, 3, 1, "approved"));
    put(lite, "borrow_requests", loan(7, 5, 1, "pending"));
    put(lite, "borrow_requests", loan(8, 5, 2, "returned"));
    put(lite, "borrow_requests", loan(9, 5, 3, "rejected"));
  });
  const db = await target(t);
  await copySqliteToPostgres(path, db);
  const shelves = await db.prepare("SELECT id, available FROM equipment ORDER BY id").all();
  assert.deepEqual(shelves.map((s) => [s.id, s.available]), [[1, 3], [2, 0], [3, 4], [4, 2], [5, 6], [6, 0]]);
});

test("copy keeps every notification row except repeated reminders the new index forbids, and reports them", async (t) => {
  const path = buildSqlite((lite) => {
    put(lite, "users", user(1));
    put(lite, "users", user(2));
    for (const n of [
      note(1, 1, "due_soon", 10), note(2, 1, "due_soon", 10), note(3, 1, "due_soon", 10), // keep 1
      note(4, 1, "request_submitted", 10), note(5, 1, "request_submitted", 10), // keep 4
      note(6, 1, "request_approved", 10), note(7, 1, "request_approved", 10), // other types may repeat
      note(8, 1, "due_soon", null), note(9, 1, "due_soon", null), // no request, no rule
      note(10, 1, "due_soon", 11), // another request
      note(11, 2, "due_soon", 10), // another user
    ]) put(lite, "notifications", n);
  });
  const db = await target(t);
  const counts = await copySqliteToPostgres(path, db);
  assert.deepEqual(counts.notifications, { copied: 8, skipped: 3 });
  const ids = (await db.prepare("SELECT id FROM notifications ORDER BY id").all()).map((r) => r.id);
  assert.deepEqual(ids, [1, 4, 6, 7, 8, 9, 10, 11]);
  const kept = await db.prepare("SELECT message FROM notifications WHERE id = 1").get();
  assert.equal(kept.message, "message 1");
  // The Postgres index still guards new rows.
  await assert.rejects(
    db.prepare("INSERT INTO notifications (user_id, type, message, request_id) VALUES (1, 'due_soon', 'again', 10)").run(),
    (err) => err.code === "23505",
  );
});

test("duplicate pending requests for one user and item: the lowest id stays pending, later ones are copied as cancelled and counted", async (t) => {
  const reason = "Duplicate pending request closed during the move to Postgres";
  const path = buildSqlite((lite) => {
    put(lite, "users", user(1));
    put(lite, "users", user(2));
    put(lite, "equipment", item(1, 3, 3));
    put(lite, "equipment", item(2, 3, 3));
    put(lite, "borrow_requests", loan(1, 1, 1, "pending"));
    put(lite, "borrow_requests", loan(2, 1, 1, "pending", { purpose: "second try" }));
    put(lite, "borrow_requests", loan(3, 1, 1, "pending"));
    put(lite, "borrow_requests", loan(4, 1, 2, "pending")); // other user: fine
    put(lite, "borrow_requests", loan(5, 2, 1, "pending")); // other item: fine
    put(lite, "borrow_requests", loan(6, 1, 1, "rejected")); // not pending: untouched
  });
  const before = fileState(path);
  const db = await target(t);
  const counts = await copySqliteToPostgres(path, db);
  assert.deepEqual(counts.borrow_requests, { copied: 6, skipped: 0, converted: 2 });
  const rows = await db.prepare("SELECT id, status, purpose, decision_reason FROM borrow_requests ORDER BY id").all();
  assert.deepEqual(
    rows.map((r) => [r.id, r.status, r.decision_reason]),
    [[1, "pending", null], [2, "cancelled", reason], [3, "cancelled", reason], [4, "pending", null], [5, "pending", null], [6, "rejected", null]],
  );
  assert.equal(rows[1].purpose, "second try"); // nothing else about the closed request is lost
  // A rerun neither inserts nor converts anything again.
  const again = await copySqliteToPostgres(path, db);
  assert.deepEqual(again.borrow_requests, { copied: 0, skipped: 6, converted: 0 });
  assertUntouched(before, path);
});

test("ids are kept, and rows added after the copy get the next id", async (t) => {
  const path = buildSqlite((lite) => {
    put(lite, "users", user(5));
    put(lite, "users", user(9));
    put(lite, "equipment", item(7, 2, 2));
    put(lite, "equipment", item(20, 1, 1));
    put(lite, "borrow_requests", loan(40, 7, 5, "pending"));
    put(lite, "notifications", note(100, 5, "request_approved", 40));
  });
  const db = await target(t);
  await copySqliteToPostgres(path, db);
  assert.deepEqual((await pgRows(db, "users")).map((u) => u.id), [5, 9]);
  assert.deepEqual((await pgRows(db, "equipment")).map((e) => e.id), [7, 20]);

  const ins = async (sql) => (await db.prepare(`${sql} RETURNING id`).run()).lastInsertRowid;
  assert.equal(await ins("INSERT INTO users (email, full_name, role, password_hash) VALUES ('new.user@student.cadt.edu.kh', 'New User', 'student', 'x')"), 10);
  assert.equal(await ins("INSERT INTO equipment (name, category, quantity) VALUES ('New', 'Laptop', 2)"), 21);
  assert.equal(await ins("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date) VALUES (7, 9, '2025-04-01', '2025-04-02')"), 41);
  assert.equal(await ins("INSERT INTO notifications (user_id, type, message) VALUES (5, 'x', 'y')"), 101);
  assert.equal((await db.prepare("SELECT asset_id FROM equipment WHERE id = 21").get()).asset_id, "CG-0021");
});

test("an empty SQLite file copies nothing and the first new rows start at id 1", async (t) => {
  const path = buildSqlite();
  const db = await target(t);
  const counts = await copySqliteToPostgres(path, db);
  assert.deepEqual(copiedOf(counts), { users: 0, sessions: 0, equipment: 0, borrow_requests: 0, notifications: 0 });
  const row = await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('First', 'Lab', 1) RETURNING id").run();
  assert.equal(row.lastInsertRowid, 1);
});

test("a copied user logs in with their old password through the real app, and an old session still works", async (t) => {
  const email = "sok.dara@student.cadt.edu.kh";
  const token = "old-session-token-for-the-copy-test";
  const path = buildSqlite();
  const lite = new DatabaseSync(path);
  put(lite, "users", { ...user(1, email), full_name: "Sok Dara", password_hash: await hashPassword("old-password-77") });
  put(lite, "sessions", { token_hash: createHash("sha256").update(token).digest("hex"), user_id: 1, expires_at: Date.now() + 3600_000 });
  lite.close();

  const db = await target(t);
  await copySqliteToPostgres(path, db);
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  const post = (body) => fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const ok = await post({ email, password: "old-password-77" });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).user, { id: 1, email, fullName: "Sok Dara", role: "student" });
  assert.equal((await post({ email, password: "old-password-78" })).status, 401);

  const me = await fetch(`${base}/me`, { headers: { Cookie: `sid=${token}` } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, email);
});

test("an older-shaped file is refused, nothing is written, and the file is untouched", async (t) => {
  const withoutAvailable = SQLITE_SCHEMA.replace("available INTEGER CHECK (available >= 0 AND available <= quantity),", "");
  const withoutNotifications = SQLITE_SCHEMA.replace(/CREATE TABLE notifications \([\s\S]*?\n {2}\);/, "");
  const noCancelled = SQLITE_SCHEMA.replace("'rejected', 'returned', 'cancelled'", "'rejected', 'returned'");
  const cases = [
    [withoutAvailable, /equipment\.available/],
    [withoutNotifications, /table notifications/],
    [noCancelled, /cancelled/],
  ];
  const db = await target(t);
  for (const [schema, expected] of cases) {
    const path = buildSqlite((lite) => {
      put(lite, "users", user(1));
      if (schema === withoutAvailable) put(lite, "equipment", { id: 1, name: "Old", category: "Laptop", quantity: 2, asset_id: "CG-0001" });
    }, schema);
    const before = fileState(path);
    await assert.rejects(copySqliteToPostgres(path, db), (err) => expected.test(err.message) && /3b3b4ad/.test(err.message));
    assert.equal(await total(db), 0);
    assertUntouched(before, path);
  }
});

test("a missing file and a file that is not SQLite give a clear error", async (t) => {
  const db = await target(t);
  await assert.rejects(copySqliteToPostgres(join(dir, "nope.db"), db), /not found/);
  const junk = join(dir, "junk.db");
  writeFileSync(junk, "this is not a database, just text ".repeat(50));
  await assert.rejects(copySqliteToPostgres(junk, db), /Cannot read .* as a SQLite database/);
  assert.equal(await total(db), 0);
});

test("the command line with no argument prints usage and exits non-zero", () => {
  const run = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Usage: node backend\/copy-sqlite\.js <path-to-sqlite-file>/);
});

test("the command line copies into the local folder, names the target kind, and never prints a URL", () => {
  const path = buildSqlite((lite) => {
    put(lite, "users", user(1));
    put(lite, "equipment", item(1, 2, 2));
  });
  const folder = join(dir, "pgdata-cli");
  const run = spawnSync(process.execPath, [script, path], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "", PGDATA_DIR: folder },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes(folder));
  assert.match(run.stdout, /users\s+copied 1, skipped 0/);
  assert.match(run.stdout, /equipment\s+copied 1, skipped 0/);

  const again = spawnSync(process.execPath, [script, path], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "", PGDATA_DIR: folder } });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /users\s+copied 0, skipped 1/);
});

test("with DATABASE_URL set the output says DATABASE_URL, and a failing connection does not leak the URL", () => {
  const path = buildSqlite((lite) => put(lite, "users", user(1)));
  const url = "postgres://someone:hunter2-secret@127.0.0.1:1/nodb";
  const run = spawnSync(process.execPath, [script, path], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } });
  assert.notEqual(run.status, 0);
  assert.ok(!(run.stdout + run.stderr).includes("hunter2-secret"));
});
