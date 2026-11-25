// Review round 2 of the SQLite to Postgres move (SCRUM-138). New cases only; nothing here repeats review1, fix1 or
// copySqlite. Titles starting with DEFECT fail until the code is fixed. Real Postgres is not available, so the
// connection-loss case talks to a tiny fake Postgres server on 127.0.0.1 in a child process.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openDb, poolConfig, withTransaction } from "./db.js";
import { copySqliteToPostgres } from "./copy-sqlite.js";

const dir = mkdtempSync(join(tmpdir(), "pg-review2-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const dbUrl = pathToFileURL(fileURLToPath(new URL("./db.js", import.meta.url))).href;
const SECRET = "s3cr3tpw-review2";

function childEnv() {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.DATABASE_CA;
  delete env.PGDATA_DIR;
  return env;
}
const runModule = (code, timeout = 60_000) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: childEnv(), timeout });

// --- 1. A connection lost in the middle of a transaction ----------------------------------------------------------

// The child starts a fake Postgres that answers startup and simple queries, and drops its first connection on the
// third query (SCHEMA, BEGIN, then the first query inside the transaction).
const FAKE_SERVER_CHILD = `
import net from "node:net";
import { openDb, withTransaction } from ${JSON.stringify(dbUrl)};
const frame = (type, body) => {
  const b = Buffer.alloc(5 + body.length);
  b.write(type, 0);
  b.writeInt32BE(4 + body.length, 1);
  body.copy(b, 5);
  return b;
};
const int32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
let connections = 0;
const server = net.createServer((sock) => {
  const n = ++connections;
  let buf = Buffer.alloc(0);
  let started = false;
  let queries = 0;
  sock.on("error", () => {});
  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (!started) {
        if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
        buf = buf.subarray(buf.readInt32BE(0));
        started = true;
        sock.write(Buffer.concat([frame("R", int32(0)), frame("Z", Buffer.from("I"))]));
        continue;
      }
      if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return;
      const type = String.fromCharCode(buf[0]);
      const body = buf.subarray(5, 1 + buf.readInt32BE(1));
      buf = buf.subarray(1 + buf.readInt32BE(1));
      if (type === "X") return sock.end();
      if (type !== "Q" && type !== "P") continue;
      queries += 1;
      if (n === 1 && queries === 3) return sock.destroy();
      if (type === "P") return sock.destroy(); // only simple queries are expected here
      const sql = body.toString("utf8", 0, body.length - 1).trim().toUpperCase();
      const tag = ["BEGIN", "COMMIT", "ROLLBACK"].find((t) => sql.startsWith(t)) ?? "SELECT 0";
      sock.write(Buffer.concat([frame("C", Buffer.from(tag + "\\0")), frame("Z", Buffer.from(tag === "BEGIN" ? "T" : "I"))]));
    }
  });
});
server.listen(0, "127.0.0.1", async () => {
  const url = "postgres://review2:${SECRET}@127.0.0.1:" + server.address().port + "/review2";
  const db = await openDb(url);
  let first;
  try {
    await withTransaction(db, async (tx) => { await tx.prepare("SELECT 1").get(); });
    first = "committed";
  } catch (err) {
    first = err.message;
  }
  const second = await withTransaction(db, async (tx) => (await tx.prepare("SELECT 2").get(), "second ok"));
  console.log(JSON.stringify({ first, second, connections }));
  process.exit(0);
});
`;

test("guard: a connection lost during a transaction crashes the whole server; it must fail that one request and the next transaction must work", () => {
  const child = runModule(FAKE_SERVER_CHILD, 30_000);
  const output = `${child.stdout}\n${child.stderr}`;
  assert.ok(!output.includes(SECRET), "the password never shows up in any output");
  // pg emits "error" on a checked-out client when its socket ends. pool.query adds a listener for its own clients,
  // db.transaction does not, so the unhandled "error" event kills the process (exit 1, "Connection terminated unexpectedly").
  assert.equal(child.status, 0, `the process died instead of failing one request:\n${child.stderr.slice(0, 600)}`);
  const result = JSON.parse(child.stdout.trim().split("\n").pop());
  assert.match(result.first, /terminated|connection/i, "the caller of the broken transaction gets the connection error");
  assert.equal(result.second, "second ok", "the broken client is dropped and a fresh connection serves the next transaction");
  assert.equal(result.connections, 2);
});

// --- 2. TLS decision and the host the connection really goes to ---------------------------------------------------

test("guard: poolConfig: a host= parameter sends pg to a remote server while TLS is decided from the localhost in the URL", () => {
  // pg-connection-string lets ?host= override the host part of the URL, so this connects to db.example.com.
  const url = `postgres://u:${SECRET}@localhost:5432/app?host=db.example.com`;
  const cfg = poolConfig(url, undefined);
  assert.notEqual(cfg.ssl, false, "the password would cross the network in plain text to db.example.com");
  // and the other way round, a local socket host stays local
  assert.equal(poolConfig("postgres://u:p@db.example.com:5432/app?host=127.0.0.1", undefined).ssl, false);
});

// --- 3. Two processes on one PGlite folder ---------------------------------------------------------------------------

test("guard: a second process on the same PGlite folder (seed:test, copy-db or the README promote command while dev:server runs) must be refused, not have its writes silently lost", async (t) => {
  const folder = join(dir, "shared-pgdata");
  const server = await openDb(folder); // stands in for npm run dev:server
  let closed = false;
  t.after(() => (closed ? undefined : server.close()));
  // The README flow: sign up on the running app, then promote the account with the README command.
  await server.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES ('ly.dara@cadt.edu.kh', 'Ly Dara', 'faculty', 'x')").run();

  const child = runModule(`
    import { openDb } from ${JSON.stringify(dbUrl)};
    const db = await openDb(${JSON.stringify(folder)});
    const { changes } = await db.prepare("UPDATE users SET role = ? WHERE email = ?").run("admin", "ly.dara@cadt.edu.kh");
    await db.close();
    console.log("promoted " + changes);
  `, 240_000);
  // A child killed by the timeout would look like a refusal, so that is ruled out first (the full suite runs slowly).
  assert.equal(child.signal, null, "the child was killed by the timeout, not refused");
  assert.ok(child.status === 0 || /in use|locked|already (open|running)/i.test(child.stderr), `a refusal must say why:\n${child.stderr.slice(0, 400)}`);
  const seenLive = (await server.prepare("SELECT role FROM users WHERE email = 'ly.dara@cadt.edu.kh'").get()).role;
  await server.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) SELECT 'tok', id, 1 FROM users").run(); // the admin logs in

  await server.close(); // dev:server restarts
  closed = true;
  const reopened = await openDb(folder);
  t.after(() => reopened.close());
  const afterRestart = (await reopened.prepare("SELECT role FROM users WHERE email = 'ly.dara@cadt.edu.kh'").get()).role;
  assert.ok(
    child.status !== 0 || (seenLive === "admin" && afterRestart === "admin"),
    `the command said "${child.stdout.trim()}" and exited 0, yet the running server saw ${seenLive} and after a restart the role is ${afterRestart}`,
  );
});

// --- 4. Re-running the SQLite copy after the app has been used ------------------------------------------------------

const SQLITE_SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'faculty', 'admin')), password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  CREATE TABLE equipment (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 0), available INTEGER CHECK (available >= 0 AND available <= quantity),
    asset_id TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT 'Main store',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE borrow_requests (id INTEGER PRIMARY KEY, equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE RESTRICT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, borrow_date TEXT NOT NULL, return_date TEXT NOT NULL, purpose TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
    returned_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    decided_by INTEGER, decided_at TEXT, decision_reason TEXT);
  CREATE TABLE notifications (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', message TEXT NOT NULL, reason TEXT, request_id INTEGER,
    read_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
`;

test("guard: a second copy after the app went live brings back a logged-out session and a deleted item", async (t) => {
  const path = join(dir, "live.db");
  const lite = new DatabaseSync(path);
  lite.exec(SQLITE_SCHEMA);
  lite.exec(`
    INSERT INTO users (id, email, full_name, role, password_hash, created_at)
      VALUES (1, 'sok.dara@student.cadt.edu.kh', 'Sok Dara', 'student', 'x', '2025-01-01 00:00:00');
    INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('${"a".repeat(64)}', 1, ${Date.now() + 86_400_000});
    INSERT INTO equipment (id, name, category, quantity, available, asset_id, created_at, updated_at)
      VALUES (1, 'Old tripod', 'Camera', 1, 1, 'CG-0001', '2025-01-01 00:00:00', '2025-01-01 00:00:00');
  `);
  lite.close();
  const db = await openDb(":memory:");
  t.after(() => db.close());

  await copySqliteToPostgres(path, db);
  // Live use on the new database: the student logs out and an admin deletes the unused tripod.
  await db.prepare("DELETE FROM sessions WHERE user_id = 1").run();
  await db.prepare("DELETE FROM equipment WHERE id = 1").run();

  let refused = false;
  try {
    await copySqliteToPostgres(path, db); // someone runs npm run copy-db a second time
  } catch {
    refused = true;
  }
  const session = await db.prepare("SELECT 1 FROM sessions WHERE user_id = 1").get();
  const tripod = await db.prepare("SELECT 1 FROM equipment WHERE id = 1").get();
  assert.ok(refused || (!session && !tripod), "rows the live app removed came back: an old login token works again and a deleted item reappears");
});

// --- 5. The nesting guard of withTransaction ------------------------------------------------------------------------

test("withTransaction: a nested call on the outer db or on the tx is refused (no PGlite deadlock) and rolls the outer work back", async (t) => {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  const add = (conn, name) => conn.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Lab', 1)").run(name);

  for (const inner of [(tx) => withTransaction(db, async () => {}), (tx) => withTransaction(tx, async () => {})]) {
    await assert.rejects(
      withTransaction(db, async (tx) => {
        await add(tx, "outer work");
        await new Promise((resolve) => setImmediate(resolve)); // still inside, after a hop through the event loop
        await inner(tx);
      }),
      /cannot run inside another transaction/,
    );
  }
  assert.equal((await db.prepare("SELECT COUNT(*)::int AS n FROM equipment").get()).n, 0, "the outer transaction rolled back");

  // Not nested: one after another, chained with then, and many at once from separate callers all run.
  await withTransaction(db, (tx) => add(tx, "first")).then(() => withTransaction(db, (tx) => add(tx, "chained")));
  await Promise.all(Array.from({ length: 8 }, (_, i) => withTransaction(db, (tx) => add(tx, `parallel ${i}`))));
  assert.equal((await db.prepare("SELECT COUNT(*)::int AS n FROM equipment").get()).n, 10);
});
