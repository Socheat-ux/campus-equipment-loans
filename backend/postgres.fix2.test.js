// Fixes for review round 2 of the SQLite to Postgres move (SCRUM-138). New cases only; nothing here repeats review1,
// fix1, review2 or copySqlite. Real Postgres is not available: pool behaviour is checked with a faked pg client, and the
// PGlite folder lock with real processes. Most cases run in memory; only the folder cases start PGlite folders.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { isPostgresUrl, openDb, poolConfig, withTransaction } from "./db.js";
import { createApp } from "./app.js";
import { copySqliteToPostgres } from "./copy-sqlite.js";

const dir = mkdtempSync(join(tmpdir(), "pg-fix2-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const dbUrl = pathToFileURL(here("db.js")).href;
const SECRET = "s3cr3tpw-fix2";
const DEAD_URL = `postgres://fix2user:${SECRET}@127.0.0.1:1/fix2db`; // nothing listens on port 1

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_ENV;
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
  return env;
}
const run = (script, args, extra, cwd) =>
  spawnSync(process.execPath, [here(script), ...args], { cwd, encoding: "utf8", timeout: 60_000, env: cleanEnv(extra) });

// --- 1. A client checked out for a transaction -------------------------------------------------------------------------

function fakeClient(script) {
  const client = new EventEmitter();
  client.released = [];
  client.release = (err) => client.released.push(err);
  client.query = (sql) => script(sql, client);
  return client;
}
const ok = Promise.resolve({ rows: [], rowCount: 0 });

async function withFakeClients(t, clients) {
  const queue = [...clients];
  t.mock.method(pg.Pool.prototype, "query", async () => ({ rows: [], rowCount: 0 }));
  t.mock.method(pg.Pool.prototype, "connect", async () => queue.shift());
  const db = await openDb(DEAD_URL);
  t.after(() => db.close());
  return db;
}

test("a connection lost mid-transaction fails that request, drops the client, and leaves no listener behind", async (t) => {
  let listenersWhileOut;
  const client = fakeClient((sql, self) => {
    if (sql !== "SELECT 1") return sql === "ROLLBACK" ? Promise.reject(new Error("Client was closed and is not queryable")) : ok;
    listenersWhileOut = self.listenerCount("error");
    return new Promise((_, reject) =>
      setImmediate(() => {
        const err = new Error("Connection terminated unexpectedly");
        self.emit("error", err); // with no listener this throws and fails the whole test run
        self.emit("error", new Error("a second event after the first")); // must not throw either
        reject(err);
      }),
    );
  });
  const db = await withFakeClients(t, [client]);
  await assert.rejects(db.transaction((tx) => tx.prepare("SELECT 1").get()), /Connection terminated unexpectedly/);
  assert.equal(listenersWhileOut, 1);
  assert.equal(client.listenerCount("error"), 0, "the listener is removed before the client goes back to the pool");
  assert.equal(client.released.length, 1);
  assert.ok(client.released[0] instanceof Error, "release(err) makes pg-pool destroy the client");
});

test("an error event between two statements still discards the client, even if the later statements succeed", async (t) => {
  const client = fakeClient(() => ok);
  const db = await withFakeClients(t, [client]);
  const result = await db.transaction(async (tx) => {
    await tx.prepare("SELECT 1").get();
    client.emit("error", new Error("server closed the connection"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "finished";
  });
  assert.equal(result, "finished");
  assert.match(String(client.released[0]?.message), /server closed the connection/);
});

test("one transaction losing its connection does not touch the three running beside it", async (t) => {
  const clients = [0, 1, 2, 3].map((n) =>
    fakeClient((sql, self) => {
      if (n !== 2 || sql !== "SELECT 1") return ok;
      const lost = new Error("lost");
      self.emit("error", lost);
      return Promise.reject(lost);
    }),
  );
  const db = await withFakeClients(t, clients);
  const results = await Promise.allSettled(clients.map(() => db.transaction((tx) => tx.prepare("SELECT 1").get())));
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "rejected", "fulfilled"]);
  assert.deepEqual(clients.map((c) => c.released[0] === undefined), [true, true, false, true]);
  assert.ok(clients.every((c) => c.listenerCount("error") === 0));
});

// --- 2. withTransaction nesting guard ends with the transaction ------------------------------------------------------------

test("a timer made inside a transaction may open its own transaction after it ended, committed or rolled back, but not while it is open", async (t) => {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  const add = (conn, name) => conn.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Lab', 1)").run(name);
  const later = [];
  const during = [];
  await withTransaction(db, async (tx) => {
    later.push(new Promise((resolve) => setTimeout(resolve, 20)).then(() => withTransaction(db, (inner) => add(inner, "after commit"))));
    during.push(new Promise((resolve) => setImmediate(resolve)).then(() => withTransaction(db, async () => {})));
    await add(tx, "outer");
    await Promise.allSettled(during);
  });
  await assert.rejects(during[0], /cannot run inside another transaction/);
  await assert.rejects(
    withTransaction(db, async () => {
      later.push(new Promise((resolve) => setTimeout(resolve, 5)).then(() => withTransaction(db, (inner) => add(inner, "after rollback"))));
      throw new Error("roll back");
    }),
    /roll back/,
  );
  await Promise.all(later);
  assert.deepEqual((await db.prepare("SELECT name FROM equipment ORDER BY id").all()).map((r) => r.name).sort(), ["after commit", "after rollback", "outer"]);
  // A different database is never blocked by the first one's open transaction.
  const other = await openDb(":memory:");
  t.after(() => other.close());
  await withTransaction(db, async () => withTransaction(other, (tx) => add(tx, "elsewhere")));
  assert.equal((await other.prepare("SELECT COUNT(*)::int AS n FROM equipment").get()).n, 1);
});

// --- 3. isPostgresUrl and the refusal of other URLs ------------------------------------------------------------------------

test("isPostgresUrl: trimmed, case-insensitive, only the two postgres schemes, and never throws", () => {
  for (const yes of ["postgres://h/db", "postgresql://h/db", "  POSTGRES://h/db\n", "PostgreSQL://u:p@h:5432/db?x=1", "\tpostgresql://"]) assert.equal(isPostgresUrl(yes), true, JSON.stringify(yes));
  for (const no of ["", "   ", undefined, null, 5, {}, "postgre://h", "postgress://h", "postgres:/h", "postgres//h", "xpostgres://h", "http://postgres://h", "mysql://h", "data/pgdata", "C:\\data\\postgres://x", ":memory:"]) {
    assert.equal(isPostgresUrl(no), false, JSON.stringify(no));
  }
});

test("openDb uses a padded or upper-case postgres URL as a URL, and refuses any other scheme without echoing it or creating a folder", async () => {
  for (const url of [`  ${DEAD_URL}  `, DEAD_URL.replace("postgres://", "POSTGRESQL://")]) {
    await assert.rejects(openDb(url), (err) => /ECONNREFUSED/.test(`${err.code} ${err.message}`) && !String(err.stack).includes(SECRET));
  }
  for (const url of [`mysql://fix2user:${SECRET}@h/x`, `  FILE:///tmp/${SECRET}`, `postgres+ssl://fix2user:${SECRET}@h/x`, `http://${SECRET}`]) {
    await assert.rejects(openDb(url), (err) => /postgres:\/\/ or postgresql:\/\//.test(err.message) && !`${err.message}${err.stack}`.includes(SECRET));
  }
});

for (const [script, args] of [["index.js", []], ["seed-dev.js", ["--remote"]], ["copy-sqlite.js", ["EXISTING"]]]) {
  test(`${script}: a DATABASE_URL that is not postgres is refused outside production too, without printing it or creating a folder`, () => {
    const cwd = mkdtempSync(join(dir, "cli-"));
    const sqlite = join(cwd, "old.db");
    const lite = new DatabaseSync(sqlite);
    lite.exec("CREATE TABLE t (x)");
    lite.close();
    for (const value of [`mysql://u:${SECRET}@h/x`, `data/${SECRET}`, `C:\\${SECRET}`]) {
      const res = run(script, args.map((a) => (a === "EXISTING" ? sqlite : a)), { DATABASE_URL: value, PGDATA_DIR: join(cwd, "own") }, cwd);
      assert.equal(res.status, 1, `${value}: ${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /DATABASE_URL.*postgres:\/\/ or postgresql:\/\//);
      assert.ok(!`${res.stdout}${res.stderr}`.includes(SECRET), "the value never shows up");
    }
    assert.deepEqual(readdirSync(cwd).sort(), ["old.db"], "no database folder was created");
  });
}

// --- 4. TLS follows the host pg really uses -------------------------------------------------------------------------------

test("poolConfig decides TLS from the host pg connects to: the same host pg-connection-string parses, for many URL shapes", () => {
  const cases = [
    ["postgres://u:p@localhost:5432/app?host=db.example.com", true],
    ["postgres://u:p@127.0.0.1/app?application_name=x&host=aws-0.pooler.supabase.com&sslmode=disable", true],
    ["postgres://u:p@[::1]:5432/app?host=db.example.com", true],
    ["postgres://u:p@db.example.com/app?host=localhost", false],
    ["postgres://u:p@db.example.com/app?host=LOCALHOST", false],
    ["postgres://u:p@db.example.com/app?host=", true],
    ["postgres://u:p@localhost/app?host=", false],
    ["postgres://u:p@localhost/app?hostaddr=10.0.0.5", false],
    ["postgres://u:p@LocalHost:5432/app", false],
    ["postgres://u:p@[::1]:5432/app", false],
    ["postgres://u:p@db.example.com:5432/app", true],
  ];
  for (const [url, remote] of cases) {
    const cfg = poolConfig(url, undefined);
    assert.equal(cfg.ssl !== false, remote, url);
    const parsed = new pg.Client(cfg).connectionParameters;
    const host = String(parsed.host).toLowerCase();
    assert.equal(["localhost", "127.0.0.1", "::1"].includes(host), !remote, `${url}: pg connects to ${host}`);
  }
  assert.deepEqual(poolConfig("postgres://u:p@localhost/app?host=db.example.com", "PEM").ssl, { ca: "PEM" });
});

// --- 5. Sort order does not depend on the database collation --------------------------------------------------------------

test("the catalogue and user lists sort by lower(...) in binary order, like SQLite did, whatever the database collation", async (t) => {
  for (const file of ["equipment.js", "users.js"]) {
    const source = readFileSync(here(file), "utf8");
    const orderings = source.match(/ORDER BY lower\(\w+\)[^`]*/g) ?? [];
    assert.ok(orderings.length >= 1, file);
    for (const ordering of orderings) assert.match(ordering, /lower\(\w+\) COLLATE "C"(,|$)/, `${file}: ${ordering}`);
  }
  const db = await openDb(":memory:");
  t.after(() => db.close());
  for (const name of ["banana", "Apple", "apple pie", "_under", "Zebra", "\u00c9clair", "10 cables", "9 cables"]) {
    await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Lab', 1)").run(name);
  }
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { equipment } = await (await fetch(`http://127.0.0.1:${server.address().port}/api/equipment`)).json();
  // Binary order of the lower-cased name: digits, underscore, ASCII letters, then non-ASCII letters last.
  assert.deepEqual(equipment.map((e) => e.name), ["10 cables", "9 cables", "_under", "Apple", "apple pie", "banana", "Zebra", "Éclair"]);
});

// --- 6. The copy into a database that is already in use ----------------------------------------------------------------------

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
const TOKEN = "f".repeat(64);
const HASH = "scrypt$hash-that-must-stay-private";
let files = 0;
function sqliteFile(extra = "") {
  const path = join(dir, `src-${++files}.db`);
  const lite = new DatabaseSync(path);
  lite.exec(SQLITE_SCHEMA);
  lite.exec(`
    INSERT INTO users (id, email, full_name, role, password_hash, created_at) VALUES
      (1, 'sok.dara@student.cadt.edu.kh', 'Sok Dara', 'student', '${HASH}', '2025-01-01 00:00:00'),
      (2, 'ly.sophea@cadt.edu.kh', 'Ly Sophea', 'faculty', 'h2', '2025-01-02 00:00:00');
    INSERT INTO sessions VALUES ('${TOKEN}', 1, 4102444800000);
    INSERT INTO equipment (id, name, category, quantity, available, asset_id, created_at, updated_at) VALUES
      (1, 'Tripod', 'Camera', 2, 2, 'CG-0001', '2025-01-01 00:00:00', '2025-01-01 00:00:00'),
      (2, 'Laptop', 'Laptop', 1, 0, '', '2025-01-01 00:00:00', '2025-01-01 00:00:00');
    INSERT INTO borrow_requests (id, equipment_id, user_id, borrow_date, return_date, status, created_at)
      VALUES (1, 2, 1, '2025-02-01', '2025-02-08', 'approved', '2025-01-30T00:00:00.000Z');
    INSERT INTO notifications (id, user_id, type, message, request_id, created_at)
      VALUES (1, 1, 'request_approved', 'ok', 1, '2025-02-01T00:00:00.000Z');
    ${extra}
  `);
  lite.close();
  return path;
}
const TABLES = ["users", "sessions", "equipment", "borrow_requests", "notifications"];
const dump = async (db) =>
  JSON.stringify(await Promise.all(TABLES.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all())), (_, v) => (typeof v === "bigint" ? String(v) : v));
const lineFor = (message, table) => message.split("\n").find((l) => l.trim().startsWith(`${table} `))?.trim().replace(/\s+/g, " ");

test("a target with rows in only one table is in use: nothing is inserted into any table, and the counts name each table", async (t) => {
  const path = sqliteFile();
  const db = await openDb(":memory:");
  t.after(() => db.close());
  // Someone signed up on the new database; only the equipment table has a row, and it is not in the SQLite file.
  await db.prepare("INSERT INTO equipment (id, name, category, quantity) VALUES (77, 'Live item', 'Lab', 1)").run();
  const before = await dump(db);
  await assert.rejects(copySqliteToPostgres(path, db), (err) => {
    assert.match(err.message, /already in use/);
    assert.equal(lineFor(err.message, "users"), "users 0 equal, 2 missing in the target, 0 different");
    assert.equal(lineFor(err.message, "equipment"), "equipment 0 equal, 2 missing in the target, 0 different");
    assert.equal(lineFor(err.message, "notifications"), "notifications 0 equal, 1 missing in the target, 0 different");
    assert.match(err.message, /Nothing was written/);
    assert.ok(!err.message.includes(TOKEN) && !err.message.includes(HASH));
    return true;
  });
  assert.equal(await dump(db), before);
  // The sequences did not move either: the next signup still gets id 1.
  assert.equal((await db.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES ('new.user@cadt.edu.kh', 'New User', 'faculty', 'x') RETURNING id").run()).lastInsertRowid, 1);
});

test("after the first copy the app is used: extra live rows are fine, a deleted or changed source row is named per table, and nothing ever moves", async (t) => {
  const path = sqliteFile();
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await copySqliteToPostgres(path, db);

  // New signups and a new item do not matter to the check.
  await db.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES ('hong.vanna@cadt.edu.kh', 'Hong Vanna', 'faculty', 'x')").run();
  await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Live item', 'Lab', 1)").run();
  const same = await dump(db);
  const counts = await copySqliteToPostgres(path, db);
  assert.deepEqual(Object.values(counts).map((c) => c.copied), [0, 0, 0, 0, 0]);
  assert.equal(await dump(db), same);

  // The live app ends a login and deletes an item that the file still lists; an admin also edits a user.
  await db.exec(`DELETE FROM sessions; DELETE FROM equipment WHERE id = 1; UPDATE users SET full_name = 'Sok Dara Edited' WHERE id = 1;`);
  const after = await dump(db);
  await assert.rejects(copySqliteToPostgres(path, db), (err) => {
    assert.equal(lineFor(err.message, "users"), "users 1 equal, 0 missing in the target, 1 different");
    assert.equal(lineFor(err.message, "sessions"), "sessions 0 equal, 1 missing in the target, 0 different");
    assert.equal(lineFor(err.message, "equipment"), "equipment 1 equal, 1 missing in the target, 0 different");
    assert.equal(lineFor(err.message, "borrow_requests"), "borrow_requests 1 equal, 0 missing in the target, 0 different");
    assert.match(err.message, /Copy failed on users id 1: a different row already has this id/);
    assert.ok(!err.message.includes(TOKEN) && !err.message.includes(HASH) && !err.message.includes("Edited"), "no secret or live data in the message");
    return true;
  });
  assert.equal(await dump(db), after, "the deleted session and item stay deleted");
  assert.equal((await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Next', 'Lab', 1) RETURNING id").run()).lastInsertRowid > 2, true);
});

test("only the first 5 differences are listed, a populated target with an empty file is fine, and a file with fewer rows than the target passes", async (t) => {
  const many = Array.from({ length: 9 }, (_, i) => `(${i + 10}, 'Item ${i}', 'Lab', 1, 1, 'A-${i}', '2025-01-01 00:00:00', '2025-01-01 00:00:00')`).join(",");
  const path = sqliteFile(`INSERT INTO equipment (id, name, category, quantity, available, asset_id, created_at, updated_at) VALUES ${many};`);
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await copySqliteToPostgres(path, db);
  await db.exec("UPDATE equipment SET name = name || '!' WHERE id >= 10");
  await assert.rejects(copySqliteToPostgres(path, db), (err) => {
    assert.equal(lineFor(err.message, "equipment"), "equipment 2 equal, 0 missing in the target, 9 different");
    assert.equal(err.message.split("\n").filter((l) => l.includes("a different row")).length, 5);
    return true;
  });
  const empty = join(dir, "empty.db");
  const lite = new DatabaseSync(empty);
  lite.exec(SQLITE_SCHEMA);
  lite.close();
  assert.deepEqual(Object.values(await copySqliteToPostgres(empty, db)).map((c) => c.copied + c.skipped), [0, 0, 0, 0, 0]);
});

test("the copy command exits 1 with the counts on stderr when the target is in use, writes nothing, and exits 0 on a true repeat", () => {
  const folder = join(dir, "cli-copy");
  const env = { DATABASE_URL: "", PGDATA_DIR: folder };
  const path = sqliteFile();
  assert.equal(run("copy-sqlite.js", [path], env).status, 0);
  const repeat = run("copy-sqlite.js", [path], env);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.match(repeat.stdout, /users\s+copied 0, skipped 2/);
  const bigger = sqliteFile("INSERT INTO users (id, email, full_name, role, password_hash) VALUES (3, 'chea.dara@cadt.edu.kh', 'Chea Dara', 'faculty', 'x');");
  const refused = run("copy-sqlite.js", [bigger], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already in use/);
  assert.match(refused.stderr, /users\s+2 equal, 1 missing in the target, 0 different/);
  assert.ok(!refused.stdout.includes("Copied"), refused.stdout);
  assert.ok(!`${refused.stdout}${refused.stderr}`.includes(HASH));
});

// --- 7. One process per PGlite folder --------------------------------------------------------------------------------------

test("a folder owned by a live process is refused before PGlite starts, by every command, and the lock is left alone", () => {
  const folder = join(dir, "busy");
  mkdirSync(folder);
  const lock = join(folder, "app.lock");
  writeFileSync(lock, String(process.pid));
  const sqlite = sqliteFile();
  for (const [script, args] of [["seed-dev.js", [folder]], ["copy-sqlite.js", [sqlite]], ["index.js", []]]) {
    const res = run(script, args, { DATABASE_URL: "", PGDATA_DIR: folder, PORT: "0" }, dir);
    assert.notEqual(res.status, 0, script);
    assert.ok(res.stderr.includes(folder), `${script} names the folder:\n${res.stderr.slice(0, 300)}`);
    assert.match(res.stderr, /npm run dev:server/);
    assert.ok(!/Test accounts in|Copied|Campus Equipment Loans on/.test(res.stdout), script);
  }
  assert.equal(readFileSync(lock, "utf8"), String(process.pid), "the owner's lock was not touched");
  assert.equal(existsSync(join(folder, "PG_VERSION")), false, "PGlite never started in the busy folder");
});

test("a lock that holds no pid is stale; while open the same folder is refused even from the same process; close removes the lock", async (t) => {
  const folder = join(dir, "garbage-lock");
  mkdirSync(folder);
  writeFileSync(join(folder, "app.lock"), "not a pid\n");
  const db = await openDb(folder);
  t.after(() => db.close().catch(() => {}));
  assert.equal(readFileSync(join(folder, "app.lock"), "utf8"), String(process.pid));
  await assert.rejects(openDb(folder), (err) => err.message.includes(folder) && /npm run dev:server/.test(err.message));
  assert.equal(readFileSync(join(folder, "app.lock"), "utf8"), String(process.pid), "the refused attempt did not remove the live lock");
  await db.close();
  assert.equal(existsSync(join(folder, "app.lock")), false);
});

test("the lock disappears on a normal exit without close, and a process killed hard leaves a stale lock the next start takes over", async (t) => {
  const exitFolder = join(dir, "exit-without-close");
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import { openDb } from ${JSON.stringify(dbUrl)}; await openDb(${JSON.stringify(exitFolder)}); process.exit(0);`],
    { encoding: "utf8", timeout: 60_000, env: cleanEnv() },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(join(exitFolder, "app.lock")), false, "removed by the exit handler");

  // dev:server under node --watch is stopped like this on a restart; the new process must not be locked out.
  const folder = join(dir, "killed-owner");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", `import { openDb } from ${JSON.stringify(dbUrl)}; await openDb(${JSON.stringify(folder)}); console.log("ready"); setInterval(() => {}, 1000);`],
    { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let seen = "";
  child.stdout.on("data", (chunk) => (seen += chunk));
  child.stderr.on("data", (chunk) => (seen += chunk));
  t.after(() => child.kill("SIGKILL"));
  const deadline = Date.now() + 60_000;
  while (!seen.includes("ready") && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(seen.includes("ready"), seen);
  const owner = String(child.pid);
  assert.equal(readFileSync(join(folder, "app.lock"), "utf8"), owner);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.equal(existsSync(join(folder, "app.lock")), true, "a killed process cannot clean up");

  const db = await openDb(folder);
  t.after(() => db.close());
  assert.equal(readFileSync(join(folder, "app.lock"), "utf8"), String(process.pid));
  assert.equal((await db.prepare("SELECT COUNT(*)::int AS n FROM users").get()).n, 0);
});

test("a database folder that fails to start gives its lock back", async () => {
  const folder = join(dir, "broken-folder");
  mkdirSync(folder);
  writeFileSync(join(folder, "PG_VERSION"), "not a version\n");
  await assert.rejects(openDb(folder));
  assert.equal(existsSync(join(folder, "app.lock")), false, "a failed start must not lock the folder for the next try");
});
