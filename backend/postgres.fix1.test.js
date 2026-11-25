// Fixes for review round 1 of the SQLite to Postgres move (SCRUM-138). New cases only; nothing here repeats an earlier file.
// Real Postgres is not available in the tests, so pool behaviour is checked with a faked pg.Pool and locks by the SQL sent.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { openDb, poolConfig } from "./db.js";
import { createApp } from "./app.js";
import { copySqliteToPostgres } from "./copy-sqlite.js";
import { processDueReminders, backfillAdminRequestNotifications } from "./notifications.js";
import { addDaysISO, borrowRequestInput, equipmentNameError, hasControlChars, rejectionReasonError, todayISO } from "../shared/rules.js";

const GOOD = "goodpass1";
const dir = mkdtempSync(join(tmpdir(), "pg-fix1-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
// A password that must never show up in any output of a child process.
const SECRET = "s3cr3tpw-fix1";
const DEAD_URL = `postgres://fixuser:${SECRET}@127.0.0.1:1/fixdb`; // port 1 on this machine: nothing listens, connect fails at once

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
  return env;
}

// Runs hook once, right after the first statement whose SQL passes match(), as if another request committed there.
function interleave(db, match, hook) {
  let done = false;
  const wrapped = {
    ...db,
    prepare(sql) {
      const stmt = db.prepare(sql);
      if (done || !match(sql)) return stmt;
      const after = (fn) => async (...params) => {
        const result = await fn(...params);
        if (!done) {
          done = true;
          await hook();
        }
        return result;
      };
      return { get: after(stmt.get), all: after(stmt.all), run: after(stmt.run) };
    },
  };
  return { wrapped, fired: () => done };
}

async function start(t, wrap) {
  const db = await openDb(":memory:");
  const appDb = wrap ? wrap(db) : db;
  const server = createApp(appDb).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await db.close();
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, cookie, body) => {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const signup = async (email) => {
    const res = await fetch(`${root}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: GOOD }),
    });
    assert.equal(res.status, 201);
    return { id: (await res.json()).user.id, cookie: res.headers.get("set-cookie").split(";")[0] };
  };
  const makeAdmin = async (email) => {
    const user = await signup(email);
    await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    return user;
  };
  const admin = await makeAdmin("ly.sophea@cadt.edu.kh");
  const item = async (name, quantity = 3) =>
    (await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Camera', ?) RETURNING id").run(name, quantity)).lastInsertRowid;
  return { db, appDb, root, call, signup, makeAdmin, admin, item };
}

// --- 1. Pool behaviour ---------------------------------------------------------------------------------------------

test("an idle connection error on the pool is logged by message only and does not crash", async (t) => {
  let pool;
  t.mock.method(pg.Pool.prototype, "query", async function () {
    pool = this;
    return { rows: [], rowCount: 0 };
  });
  const logged = t.mock.method(console, "error", () => {});
  const db = await openDb(DEAD_URL);
  t.after(() => db.close());

  assert.ok(pool.listenerCount("error") >= 1, "without a listener an emitted 'error' kills the process");
  const err = new Error("terminating connection due to administrator command");
  err.stack = `${err.stack}\n    at secret-location (${DEAD_URL})`;
  pool.emit("error", err);
  pool.emit("error", Object.assign(new Error("second drop"), { code: "57P01" })); // and a second one still does not throw
  assert.equal(logged.mock.calls.length, 2);
  for (const call of logged.mock.calls) {
    assert.ok(call.arguments.every((a) => typeof a === "string"), "strings only, never the error object with its stack");
    assert.ok(!call.arguments.join(" ").includes(SECRET));
  }
  assert.match(logged.mock.calls[0].arguments.join(" "), /terminating connection due to administrator command/);
});

test("a client that cannot ROLLBACK is discarded by release(err); a clean rollback is released normally", async (t) => {
  const released = [];
  let failRollback = true;
  t.mock.method(pg.Pool.prototype, "query", async () => ({ rows: [], rowCount: 0 }));
  t.mock.method(pg.Pool.prototype, "connect", async () => ({
    query: async (sql) => {
      if (sql === "ROLLBACK" && failRollback) throw new Error("connection already closed");
      return { rows: [], rowCount: 0 };
    },
    release: (err) => released.push(err),
  }));
  const db = await openDb(DEAD_URL);
  t.after(() => db.close());

  await assert.rejects(db.transaction(async () => { throw new Error("boom"); }), /^Error: boom$/, "the caller sees the original error, not the rollback error");
  assert.equal(released.length, 1);
  assert.match(String(released[0]?.message), /connection already closed/);

  failRollback = false;
  await assert.rejects(db.transaction(async () => { throw new Error("again"); }), /again/);
  assert.equal(released[1], undefined, "a healthy client goes back to the pool");
  assert.equal(await db.transaction(async () => 42), 42);
  assert.equal(released[2], undefined);
});

// --- 2. TLS settings -----------------------------------------------------------------------------------------------

test("poolConfig: local hosts get no TLS whatever the URL says, remote hosts always get TLS", () => {
  for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "[::1]"]) {
    for (const query of ["", "?sslmode=require", "?sslmode=verify-full&sslrootcert=/missing.pem", "?ssl=true"]) {
      const cfg = poolConfig(`postgres://u:p@${host}:5432/app${query}`, "PEM");
      assert.equal(cfg.ssl, false, `${host}${query}`);
      assert.ok(!/ssl/i.test(cfg.connectionString), "no ssl parameter reaches pg");
    }
  }
  for (const host of ["db.abcdefgh.supabase.co", "aws-0-ap-southeast-1.pooler.supabase.com", "10.0.0.5", "localhost.evil.example", "127.0.0.1.nip.io"]) {
    assert.deepEqual(poolConfig(`postgres://u:p@${host}:5432/postgres`, undefined).ssl, { rejectUnauthorized: false }, host);
    assert.deepEqual(poolConfig(`postgres://u:p@${host}:5432/postgres`, "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n").ssl, {
      ca: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n",
    });
  }
});

test("poolConfig: sslmode in the URL cannot switch TLS off or point pg at a file, other parameters and the password survive", () => {
  const url = "postgres://postgres.abc:p%40ss%3Aw%2Frd@db.example.invalid:6543/postgres?sslmode=disable&application_name=campus&SSLROOTCERT=/etc/passwd&sslcert=/x&sslkey=/y&uselibpqcompat=true&sslnegotiation=direct";
  const cfg = poolConfig(url, undefined);
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: false });
  assert.equal(cfg.connectionString, "postgres://postgres.abc:p%40ss%3Aw%2Frd@db.example.invalid:6543/postgres?application_name=campus");
  assert.equal(cfg.connectionTimeoutMillis, 10_000);
  assert.equal(cfg.max, 5);
  // pg itself must now read the same ssl value we chose: the stripped URL produces no ssl of its own.
  const parsed = new pg.Client(cfg).connectionParameters;
  assert.deepEqual(parsed.ssl, { rejectUnauthorized: false });
  assert.equal(parsed.password, "p@ss:w/rd");
  assert.equal(parsed.application_name, "campus");
  assert.equal(new pg.Client(poolConfig("postgres://u:p@127.0.0.1:1/x?sslmode=require")).connectionParameters.ssl, false);
});

test("poolConfig: an unreadable URL is treated as remote and never echoed in an error", () => {
  const cfg = poolConfig("not a url at all", undefined);
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: false });
});

test("openDb against a dead port fails fast with an error that does not contain the URL", async () => {
  const started = Date.now();
  await assert.rejects(openDb(DEAD_URL), (err) => {
    assert.ok(!String(err.message).includes(SECRET) && !String(err.stack).includes(SECRET));
    return true;
  });
  assert.ok(Date.now() - started < 8000, "a refused connection answers at once");
});

// --- 3. Production start-up ----------------------------------------------------------------------------------------

test("index.js: NODE_ENV=production without a postgres:// DATABASE_URL (unset, empty, blank or another scheme) prints an error and exits 1 without creating a database", () => {
  for (const value of [undefined, "   ", "mysql://u:p@127.0.0.1:1/x", "data/pgdata"]) {
    const cwd = mkdtempSync(join(dir, "prod-"));
    const folder = join(cwd, "own-pgdata");
    const run = spawnSync(process.execPath, [here("index.js")], {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
      env: cleanEnv({ NODE_ENV: "production", DATABASE_URL: value, PGDATA_DIR: folder, PORT: "0" }),
    });
    assert.equal(run.status, 1, `DATABASE_URL=${JSON.stringify(value)}: ${run.stderr}`);
    assert.match(run.stderr, /DATABASE_URL/);
    assert.ok(!existsSync(folder) && !existsSync(join(cwd, "data")), "no PGlite fallback folder");
    assert.ok(!run.stdout.includes("Campus Equipment Loans on"), "the server did not start");
  }
});

test("index.js: NODE_ENV=production with a DATABASE_URL tries Postgres, never PGlite, and never prints the password", () => {
  const cwd = mkdtempSync(join(dir, "prod-"));
  const run = spawnSync(process.execPath, [here("index.js")], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: cleanEnv({ NODE_ENV: "production", DATABASE_URL: DEAD_URL, PGDATA_DIR: join(cwd, "own-pgdata"), PORT: "0" }),
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /ECONNREFUSED/);
  assert.ok(!`${run.stdout}${run.stderr}`.includes(SECRET));
  assert.ok(!existsSync(join(cwd, "own-pgdata")) && !existsSync(join(cwd, "data")));
});

test("a Postgres start never loads PGlite (a production install has no dev dependencies), the PGlite branch does", () => {
  const hooks = join(dir, "blocker-hooks.mjs");
  const register = join(dir, "blocker-register.mjs");
  const main = join(dir, "blocker-main.mjs");
  writeFileSync(hooks, `export async function resolve(spec, ctx, next) { if (spec.includes("@electric-sql/pglite")) throw new Error("PGLITE_LOADED"); return next(spec, ctx); }`);
  writeFileSync(register, `import { register } from "node:module"; register(${JSON.stringify(pathToFileURL(hooks).href)});`);
  writeFileSync(
    main,
    `const { openDb } = await import(${JSON.stringify(pathToFileURL(here("db.js")).href)});
     const out = {};
     for (const [name, url] of [["postgres", ${JSON.stringify(DEAD_URL)}], ["memory", ":memory:"]]) {
       try { await openDb(url); out[name] = "opened"; } catch (err) { out[name] = err.code || err.message; }
     }
     console.log(JSON.stringify(out));`,
  );
  const run = spawnSync(process.execPath, ["--import", pathToFileURL(register).href, main], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split("\n").pop());
  assert.equal(out.postgres, "ECONNREFUSED", "the Postgres branch got as far as connecting, so pglite was not needed");
  assert.equal(out.memory, "PGLITE_LOADED", "the block works, so the line above proves something");
});

test("pg is a runtime dependency and pglite is not", async () => {
  const pkg = JSON.parse(readFileSync(here("../package.json"), "utf8"));
  assert.ok(pkg.dependencies.pg);
  assert.ok(!pkg.dependencies["@electric-sql/pglite"] && pkg.devDependencies["@electric-sql/pglite"]);
});

// --- 4. seed-dev refuses a configured database --------------------------------------------------------------------

test("seed-dev refuses when DATABASE_URL is set unless --remote, without printing the URL or touching a folder", () => {
  const cwd = mkdtempSync(join(dir, "seed-"));
  const folder = join(cwd, "pgdata");
  for (const args of [[folder], ["--remoot"], ["remote"]]) {
    const run = spawnSync(process.execPath, [here("seed-dev.js"), ...args], {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
      env: cleanEnv({ NODE_ENV: undefined, DATABASE_URL: DEAD_URL }),
    });
    assert.equal(run.status, 1, `${args.join(" ")}: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /Refusing/);
    assert.match(run.stderr, /--remote/);
    const output = `${run.stdout}${run.stderr}`;
    for (const leak of [SECRET, "fixuser", "fixdb", "127.0.0.1"]) assert.ok(!output.includes(leak), `${leak} leaked`);
  }
  assert.ok(!existsSync(folder) && !existsSync(join(cwd, "data")));
});

test("seed-dev with --remote goes on to the database (and still refuses production)", () => {
  const cwd = mkdtempSync(join(dir, "seed-"));
  const run = spawnSync(process.execPath, [here("seed-dev.js"), "--remote"], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: cleanEnv({ NODE_ENV: undefined, DATABASE_URL: DEAD_URL }),
  });
  assert.notEqual(run.status, 0);
  assert.ok(!/Refusing/.test(run.stderr), "past the guard, so it died connecting");
  assert.match(run.stderr, /ECONNREFUSED/);
  assert.ok(!`${run.stdout}${run.stderr}`.includes(SECRET));

  const prod = spawnSync(process.execPath, [here("seed-dev.js"), "--remote"], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: cleanEnv({ NODE_ENV: "production", DATABASE_URL: DEAD_URL }),
  });
  assert.equal(prod.status, 1);
  assert.match(prod.stderr, /NODE_ENV=production/);
});

// --- 5. Row level security -----------------------------------------------------------------------------------------

test("row level security is on for every table, works twice on the same folder, and hides rows from a non-owner role", async (t) => {
  const folder = join(dir, "rls-folder");
  const first = await openDb(folder);
  await first.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES ('rls.user@cadt.edu.kh', 'Rls User', 'faculty', 'x')").run();
  await first.close();
  const db = await openDb(folder); // the schema runs again over the existing tables
  t.after(() => db.close());

  const names = ["users", "sessions", "equipment", "borrow_requests", "notifications"];
  const flags = await db.prepare("SELECT relname, relrowsecurity FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY relname").all();
  assert.deepEqual(flags.map((f) => f.relname), [...names].sort());
  assert.ok(flags.every((f) => f.relrowsecurity === true), JSON.stringify(flags));

  await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Tripod', 'Camera', 1)").run();
  await db.exec("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon_probe') THEN CREATE ROLE anon_probe NOLOGIN; END IF; END $$; GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon_probe;");
  await db.exec("SET ROLE anon_probe");
  try {
    for (const name of names) assert.equal((await db.prepare(`SELECT COUNT(*)::int AS n FROM ${name}`).get()).n, 0, `${name} is readable by a non-owner`);
  } finally {
    await db.exec("RESET ROLE");
  }
  assert.equal((await db.prepare("SELECT COUNT(*)::int AS n FROM users").get()).n, 1, "the owner still sees its rows");
  assert.equal((await db.prepare("SELECT COUNT(*)::int AS n FROM equipment").get()).n, 1);
});

test("the whole app still works with row level security on (sign up, request, approve, bell)", async (t) => {
  const h = await start(t);
  const student = await h.signup("pen.vuthy@student.cadt.edu.kh");
  const camera = await h.item("Canon camera");
  const made = await h.call("POST", "/api/borrow-requests", student.cookie, { equipmentId: camera, borrowDate: addDaysISO(todayISO(), 1) });
  assert.equal(made.status, 201);
  assert.equal((await h.call("POST", `/api/admin/borrow-requests/${made.body.request.id}/approve`, h.admin.cookie, {})).status, 200);
  assert.equal((await h.call("GET", "/api/notifications", student.cookie)).body.notifications.length, 2);
});

// --- 6. Copy script: a taken id must be the same row ---------------------------------------------------------------

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
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, borrow_date TEXT NOT NULL, return_date TEXT NOT NULL,
    purpose TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
    returned_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    decided_by INTEGER, decided_at TEXT, decision_reason TEXT);
  CREATE TABLE notifications (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', message TEXT NOT NULL, reason TEXT, request_id INTEGER,
    read_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
`;
const hashOf = (token) => createHash("sha256").update(token).digest("hex");
const TOKEN_A = hashOf("fix1-session-a");
const TOKEN_B = hashOf("fix1-session-b");
let files = 0;

// Rows with every column filled, so a mismatch in any single column is visible.
function writeSqlite({ extra }) {
  const path = join(dir, `src-${++files}.db`);
  const lite = new DatabaseSync(path);
  lite.exec(SQLITE_SCHEMA);
  const put = (sql, ...values) => lite.prepare(sql).run(...values);
  const user = (id, email, role) =>
    put("INSERT INTO users (id, email, full_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, 'hash', '2025-01-02 03:04:05')", id, email, `Name ${id}`, role, );
  user(1, "sok.dara@student.cadt.edu.kh", "student");
  user(2, "chan.mony@cadt.edu.kh", "faculty");
  put("INSERT INTO sessions VALUES (?, 1, 4102444800000)", TOKEN_A);
  put("INSERT INTO equipment VALUES (1, 'Projector', 'Projector', 5, 2, 'AS-9', 'Lab A', '2025-01-01 00:00:00', '2025-01-05 00:00:00')");
  put("INSERT INTO equipment VALUES (2, 'Tripod', 'Camera', 3, 3, 'AS-10', 'Store', '2025-01-01 00:00:00', '2025-01-05 00:00:00')");
  put("INSERT INTO borrow_requests VALUES (1, 1, 1, '2025-03-01', '2025-03-08', 'Demo day', 'approved', NULL, '2025-02-27T01:02:03.004Z', 2, '2025-02-28T01:02:03.004Z', 'ok')");
  put("INSERT INTO notifications VALUES (1, 1, 'request_approved', 'Request approved', 'Approved.', 'a reason', 1, NULL, '2025-02-28T01:02:03.004Z')");
  if (extra) {
    user(3, "ly.sophea@student.cadt.edu.kh", "student");
    put("INSERT INTO sessions VALUES (?, 3, 4102444800000)", TOKEN_B);
    put("INSERT INTO equipment (id, name, category, quantity, available, asset_id) VALUES (3, 'Laptop', 'Laptop', 4, NULL, '')"); // gets a shelf count and an asset id on the way in
    put("INSERT INTO borrow_requests (id, equipment_id, user_id, borrow_date, return_date, status) VALUES (2, 3, 3, '2025-04-01', '2025-04-08', 'pending')");
    put("INSERT INTO notifications (id, user_id, type, title, message) VALUES (2, 3, 'request_submitted', 'Request submitted', 'Submitted.')");
  }
  lite.close();
  return path;
}

const TABLES = { users: "id", sessions: "token_hash", equipment: "id", borrow_requests: "id", notifications: "id" };
const snapshot = async (db) =>
  JSON.stringify(
    await Promise.all(Object.entries(TABLES).map(async ([table, key]) => (await db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all()))),
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
  );
const total = (counts) => Object.values(counts).reduce((sum, { copied }) => sum + copied, 0);

test("a taken id is fine only for the same row: changing any single column of any copied row makes the next copy fail and write nothing", async (t) => {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  const base = writeSqlite({ extra: false });
  const more = writeSqlite({ extra: true });
  assert.equal(total(await copySqliteToPostgres(base, db)), 2 + 1 + 2 + 1 + 1);
  const stable = await snapshot(db);

  const columns = await db.prepare("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position").all();
  // Columns whose values are restricted by a check constraint get a different allowed value instead of a suffix.
  const swap = { "users.role": ["student", "faculty"], "borrow_requests.status": ["approved", "returned"] };
  let checked = 0;
  for (const { table_name: table, column_name: column, data_type: type } of columns) {
    const key = TABLES[table];
    if (!key || column === key) continue; // the key is how the row is found; a different key is simply a new row
    const target = table === "sessions" ? `${key} = '${TOKEN_A}'` : `${key} = 1`;
    const original = (await db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${target}`).get()).v;
    const mutate = swap[`${table}.${column}`]
      ? `CASE WHEN ${column} = '${swap[`${table}.${column}`][0]}' THEN '${swap[`${table}.${column}`][1]}' ELSE '${swap[`${table}.${column}`][0]}' END`
      : type === "text" ? `COALESCE(${column}, '') || 'X'` : `COALESCE(${column}, 0) + 1`;
    await db.exec(`UPDATE ${table} SET ${column} = ${mutate} WHERE ${target}`);
    const changed = await snapshot(db);
    assert.notEqual(changed, stable, `${table}.${column} was not changed by the test itself`);

    const expected = new RegExp(`Copy failed on ${table} (id|user_id) 1: a different row already has this id`);
    await assert.rejects(copySqliteToPostgres(more, db), expected, `${table}.${column}`);
    assert.equal(await snapshot(db), changed, `${table}.${column}: the failed copy must write nothing, not even the new rows before it`);

    await db.exec(`UPDATE ${table} SET ${column} = ${original === null ? "NULL" : typeof original === "string" ? `'${original.replaceAll("'", "''")}'` : original} WHERE ${target}`);
    assert.equal(await snapshot(db), stable, `${table}.${column} was not restored`);
    checked++;
  }
  assert.ok(checked >= 30, `only ${checked} columns were checked`);

  const first = await copySqliteToPostgres(more, db);
  assert.equal(total(first), 5, "only the five new rows go in");
  const asset = await db.prepare("SELECT asset_id, available FROM equipment WHERE id = 3").get();
  assert.deepEqual({ ...asset }, { asset_id: "CG-0003", available: 4 });
  const after = await snapshot(db);

  const again = await copySqliteToPostgres(more, db);
  assert.equal(total(again), 0, "a true second run, even with a filled asset id and shelf count, copies nothing");
  assert.equal(again.equipment.skipped, 3);
  assert.equal(await snapshot(db), after);
});

test("a mismatching session is named by its user and never by its token", async (t) => {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  const path = writeSqlite({ extra: false });
  await copySqliteToPostgres(path, db);
  await db.exec(`UPDATE sessions SET expires_at = 1 WHERE token_hash = '${TOKEN_A}'`);
  await assert.rejects(copySqliteToPostgres(path, db), (err) => {
    assert.match(err.message, /Copy failed on sessions user_id 1: a different row already has this id/);
    assert.ok(!err.message.includes(TOKEN_A) && !err.message.includes("fix1-session"));
    return true;
  });
});

test("a different row on a duplicate-pending id is judged after the duplicate is converted to cancelled", async (t) => {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  const path = join(dir, `dup-${++files}.db`);
  const lite = new DatabaseSync(path);
  lite.exec(SQLITE_SCHEMA);
  lite.exec("PRAGMA foreign_keys = OFF");
  lite.exec(`
    INSERT INTO users (id, email, full_name, role, password_hash) VALUES (1, 'sok.dara@student.cadt.edu.kh', 'Sok Dara', 'student', 'h');
    INSERT INTO equipment (id, name, category, quantity, available, asset_id) VALUES (1, 'Kit', 'Lab', 2, 2, 'K-1');
    INSERT INTO borrow_requests (id, equipment_id, user_id, borrow_date, return_date, status, created_at) VALUES
      (1, 1, 1, '2025-05-01', '2025-05-08', 'pending', '2025-04-01T00:00:00.000Z'),
      (2, 1, 1, '2025-05-02', '2025-05-09', 'pending', '2025-04-02T00:00:00.000Z');
  `);
  lite.close();
  assert.deepEqual((await copySqliteToPostgres(path, db)).borrow_requests, { copied: 2, skipped: 0, converted: 1 });
  const again = await copySqliteToPostgres(path, db);
  assert.deepEqual(again.borrow_requests, { copied: 0, skipped: 2, converted: 0 }, "the converted row equals its own converted copy");
  // Postgres refuses a second pending row, so the only way to differ is the reason text.
  await db.exec("UPDATE borrow_requests SET decision_reason = 'edited by an admin' WHERE id = 2");
  await assert.rejects(copySqliteToPostgres(path, db), /Copy failed on borrow_requests id 2: a different row already has this id/);
});

// --- 7. Control characters -----------------------------------------------------------------------------------------

test("shared rules: NUL and other control characters are refused, tab, newline and carriage return stay legal in multi-line text", () => {
  const bad = ["\u0000", "\u0001", "\u0008", "\u000b", "\u000c", "\u000e", "\u001f"];
  for (const ch of bad) {
    assert.equal(hasControlChars(`a${ch}b`), true, JSON.stringify(ch));
    assert.match(borrowRequestInput({ equipmentId: 1, borrowDate: todayISO(), purpose: `x${ch}y` }).fields.purpose, /control characters/);
    assert.match(rejectionReasonError(`x${ch}y`), /control characters/);
    assert.match(equipmentNameError(`x${ch}y`), /control characters/);
  }
  for (const ch of ["\t", "\n", "\r", " ", "é", "សួស្តី"]) {
    assert.equal(hasControlChars(`a${ch}b`), false, JSON.stringify(ch));
    assert.equal(borrowRequestInput({ equipmentId: 1, borrowDate: todayISO(), purpose: `x${ch}y` }).fields.purpose, undefined);
    assert.equal(rejectionReasonError(`x${ch}y`), null);
  }
  for (const ch of ["\t", "\n", "\r"]) assert.match(equipmentNameError(`Cable${ch}box`), /control characters/, "a name is one line");
  assert.equal(equipmentNameError("Cable box\n"), null, "trailing whitespace is trimmed before saving");
  assert.equal(hasControlChars(undefined), false);
  assert.equal(hasControlChars(5), false);
  // A reason that is only a control character is not "empty": it gets the control message, not the required message.
  assert.match(rejectionReasonError("\u0000"), /control characters/);
});

test("the API answers 400 with a field message for control characters in every user text, and stores nothing", async (t) => {
  const h = await start(t);
  const student = await h.signup("pen.sokha@student.cadt.edu.kh");
  const camera = await h.item("Canon camera");
  const lens = await h.item("Canon lens");
  const tomorrow = addDaysISO(todayISO(), 1);
  const notices = async () => (await h.db.prepare("SELECT COUNT(*)::int AS n FROM notifications").get()).n;

  for (const purpose of ["Club\u0000event", "bell\u0007", "\u001bescape", "ok\u0001"]) {
    const res = await h.call("POST", "/api/borrow-requests", student.cookie, { equipmentId: camera, borrowDate: tomorrow, purpose });
    assert.equal(res.status, 400, JSON.stringify(purpose));
    assert.match(res.body.fields.purpose, /Purpose cannot contain control characters/);
  }
  assert.equal(await notices(), 0);
  const multi = await h.call("POST", "/api/borrow-requests", student.cookie, { equipmentId: camera, borrowDate: tomorrow, purpose: "Line one\r\nLine two\twith tab" });
  assert.equal(multi.status, 201);
  assert.equal(multi.body.request.purpose, "Line one\r\nLine two\twith tab");

  for (const name of ["Tripod\u0000", "Tri\u0000pod", "Tri\tpod", "Tri\npod", "\u0001Tripod"]) {
    const created = await h.call("POST", "/api/equipment", h.admin.cookie, { name, category: "Camera", quantity: 1 });
    assert.equal(created.status, 400, JSON.stringify(name));
    assert.match(created.body.fields.name, /control characters/);
    const edited = await h.call("PUT", `/api/equipment/${lens}`, h.admin.cookie, { name, category: "Camera", quantity: 1 });
    assert.equal(edited.status, 400, `PUT ${JSON.stringify(name)}`);
  }
  assert.equal((await h.db.prepare("SELECT name FROM equipment WHERE id = ?").get(lens)).name, "Canon lens");
  assert.equal((await h.db.prepare("SELECT COUNT(*)::int AS n FROM equipment").get()).n, 2);

  const before = await notices();
  const rejectId = multi.body.request.id;
  for (const reason of ["Booked\u0000", "\u0002", "x\u001fy"]) {
    const res = await h.call("POST", `/api/admin/borrow-requests/${rejectId}/reject`, h.admin.cookie, { reason });
    assert.equal(res.status, 400, JSON.stringify(reason));
    assert.match(res.body.fields.reason, /control characters/);
  }
  assert.equal((await h.db.prepare("SELECT status FROM borrow_requests WHERE id = ?").get(rejectId)).status, "pending");
  assert.equal(await notices(), before);
  const okReject = await h.call("POST", `/api/admin/borrow-requests/${rejectId}/reject`, h.admin.cookie, { reason: "Booked\nfor the club\tthat week" });
  assert.equal(okReject.status, 200);

  const second = await h.call("POST", "/api/borrow-requests", student.cookie, { equipmentId: lens, borrowDate: tomorrow });
  assert.equal(second.status, 201);
  const approved = await h.call("POST", `/api/admin/borrow-requests/${second.body.request.id}/approve`, h.admin.cookie, {});
  assert.equal(approved.status, 200);
  const stock = async () => (await h.db.prepare("SELECT available FROM equipment WHERE id = ?").get(lens)).available;
  const stockBefore = await stock();
  for (const reason of ["Broken\u0000", "\u0003", "a\u001fb"]) {
    const res = await h.call("POST", `/api/admin/borrow-requests/${second.body.request.id}/cancel`, h.admin.cookie, { reason });
    assert.equal(res.status, 400, JSON.stringify(reason));
    assert.match(res.body.fields.reason, /control characters/);
  }
  assert.equal((await h.db.prepare("SELECT status FROM borrow_requests WHERE id = ?").get(second.body.request.id)).status, "approved");
  assert.equal(await stock(), stockBefore, "a refused cancel does not give the item back");
  const okCancel = await h.call("POST", `/api/admin/borrow-requests/${second.body.request.id}/cancel`, h.admin.cookie, { reason: "Two\nlines" });
  assert.equal(okCancel.status, 200);
  assert.equal(await stock(), stockBefore + 1);
});

// --- 8. Foreign key races ------------------------------------------------------------------------------------------

test("equipment delete: Postgres 23001 and 23503 from a request that slipped in answer the usual 409, any other error stays a 500", async (t) => {
  for (const [code, status] of [["23001", 409], ["23503", 409], ["40P01", 500], [undefined, 500]]) {
    const h = await start(t, (db) => ({
      ...db,
      prepare(sql) {
        const stmt = db.prepare(sql);
        if (!sql.startsWith("DELETE FROM equipment")) return stmt;
        return { ...stmt, run: async () => { throw Object.assign(new Error("update or delete on table violates foreign key constraint"), { code }); } };
      },
    }));
    const camera = await h.item("Sony camera");
    const res = await h.call("DELETE", `/api/equipment/${camera}`, h.admin.cookie);
    assert.equal(res.status, status, String(code));
    if (status === 409) assert.equal(res.body.error, "Cannot delete equipment that has existing borrow requests.");
    assert.ok(await h.db.prepare("SELECT 1 FROM equipment WHERE id = ?").get(camera));
  }
});

test("borrow request create: 23503 on the insert answers 404 Equipment not found, other codes do not, and nothing is half-saved", async (t) => {
  for (const [code, status] of [["23503", 404], ["23514", 500]]) {
    const h = await start(t, (db) => ({
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            prepare(sql) {
              const stmt = tx.prepare(sql);
              if (!sql.includes("INSERT INTO borrow_requests")) return stmt;
              return { ...stmt, run: async () => { throw Object.assign(new Error("insert violates foreign key constraint"), { code }); } };
            },
          }),
        ),
    }));
    const student = await h.signup("heng.sambo@student.cadt.edu.kh");
    const camera = await h.item("Rode microphone");
    const res = await h.call("POST", "/api/borrow-requests", student.cookie, { equipmentId: camera, borrowDate: addDaysISO(todayISO(), 1) });
    assert.equal(res.status, status, code);
    if (status === 404) assert.deepEqual(res.body, { error: "Equipment not found." });
    assert.equal((await h.db.prepare("SELECT COUNT(*)::int AS n FROM borrow_requests").get()).n, 0);
    assert.equal((await h.db.prepare("SELECT COUNT(*)::int AS n FROM notifications").get()).n, 0);
  }
});

// --- 9. Lock modes -------------------------------------------------------------------------------------------------

test("row locks on users and equipment are FOR NO KEY UPDATE; borrow_requests keeps FOR UPDATE", async (t) => {
  const sent = [];
  const spy = (conn) => ({ ...conn, prepare: (sql) => (sent.push(sql), conn.prepare(sql)) });
  const h = await start(t, (db) => ({ ...spy(db), transaction: (fn) => db.transaction((tx) => fn(spy(tx))) }));
  const student = await h.signup("tep.rattana@student.cadt.edu.kh");
  const other = await h.makeAdmin("chea.sambath@cadt.edu.kh");
  const kit = await h.item("Arduino kit", 2);
  const tomorrow = addDaysISO(todayISO(), 1);
  const request = async (equipmentId) => (await h.call("POST", "/api/borrow-requests", student.cookie, { equipmentId, borrowDate: tomorrow })).body.request.id;

  const a = await request(kit);
  assert.equal((await h.call("POST", `/api/admin/borrow-requests/${a}/approve`, h.admin.cookie, {})).status, 200); // equipment lock
  assert.equal((await h.call("POST", `/api/admin/borrow-requests/${a}/return`, h.admin.cookie, {})).status, 200); // equipment lock
  const b = await request(kit);
  assert.equal((await h.call("POST", `/api/admin/borrow-requests/${b}/reject`, other.cookie, { reason: "Not now" })).status, 200); // equipment lock
  const c = await request(kit);
  assert.equal((await h.call("POST", `/api/admin/borrow-requests/${c}/approve`, other.cookie, {})).status, 200);
  assert.equal((await h.call("POST", `/api/admin/borrow-requests/${c}/cancel`, h.admin.cookie, { reason: "Broken" })).status, 200); // equipment lock
  assert.equal((await h.call("PUT", `/api/equipment/${kit}`, h.admin.cookie, { name: "Arduino kit 2", category: "Lab", quantity: 4 })).status, 200); // equipment lock
  assert.equal((await h.call("PATCH", `/api/users/${student.id}/role`, h.admin.cookie, { role: "faculty" })).status, 200); // users locks

  const locks = sent.filter((sql) => /\bFOR\b/.test(sql));
  const on = (table) => locks.filter((sql) => new RegExp(`FROM ${table}\\b`).test(sql));
  assert.ok(on("equipment").length >= 5, `equipment locks seen: ${on("equipment").length}`);
  assert.ok(on("users").length >= 2);
  for (const sql of [...on("equipment"), ...on("users")]) {
    assert.match(sql, /FOR NO KEY UPDATE$/, sql);
    assert.ok(!/FOR UPDATE/.test(sql), sql);
  }
  const requestLocks = on("borrow_requests");
  assert.ok(requestLocks.length >= 4);
  for (const sql of requestLocks) assert.match(sql, /FOR UPDATE$/, sql);
});

test("role changes still keep the last administrator after the lock change, and demoting two admins one after the other leaves one", async (t) => {
  const h = await start(t);
  const second = await h.makeAdmin("chea.sambath@cadt.edu.kh");
  // The same admin demotes the other one and themself at once: whichever runs second must be refused.
  const results = await Promise.all([
    h.call("PATCH", `/api/users/${second.id}/role`, h.admin.cookie, { role: "faculty" }),
    h.call("PATCH", `/api/users/${h.admin.id}/role`, h.admin.cookie, { role: "faculty" }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results));
  assert.ok(results.some((r) => r.status === 409), "the second change is refused as the last administrator");
  assert.equal((await h.db.prepare("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'").get()).n, 1);
});

// --- 10. Reminders -------------------------------------------------------------------------------------------------

async function loanSetup(t, wrap) {
  const h = await start(t, wrap);
  const today = todayISO();
  const people = [];
  for (const email of ["kong.vireak@student.cadt.edu.kh", "nhem.sovann@student.cadt.edu.kh", "oum.dalin@student.cadt.edu.kh", "prum.rotha@student.cadt.edu.kh"]) {
    people.push(await h.signup(email));
  }
  const loan = async (user, name, returnDate, status = "approved") => {
    const equipmentId = await h.item(name);
    return (
      await h.db
        .prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, status) VALUES (?, ?, ?, ?, ?) RETURNING id")
        .run(equipmentId, user.id, addDaysISO(today, -6), returnDate, status)
    ).lastInsertRowid;
  };
  return { h, today, tomorrow: addDaysISO(today, 1), people, loan };
}

test("reminders: exact counts, message text, title and id order for several loans, and a repeat adds nothing", async (t) => {
  const { h, today, tomorrow, people, loan } = await loanSetup(t);
  const a = await loan(people[0], "Mic 'A' ? $1 %_ \\ kit", tomorrow);
  const b = await loan(people[1], "Projector", tomorrow);
  const already = await loan(people[2], "Lens", tomorrow);
  await h.db.prepare("INSERT INTO notifications (user_id, type, title, message, request_id) VALUES (?, 'due_soon', 'Return due tomorrow', 'old', ?)").run(people[2].id, already);
  await loan(people[3], "Tripod", tomorrow, "returned");
  await loan(people[3], "Cable", tomorrow, "cancelled");
  await loan(people[3], "Router", tomorrow, "pending");
  await loan(people[3], "Switch", addDaysISO(today, 2));
  await loan(people[3], "Screen", today);

  assert.equal(await processDueReminders(h.appDb), 2);
  const rows = await h.db.prepare("SELECT user_id, type, title, message, reason, request_id, read_at, created_at FROM notifications WHERE message <> 'old' ORDER BY id").all();
  assert.deepEqual(rows.map((r) => ({ ...r, created_at: undefined })), [
    { user_id: people[0].id, type: "due_soon", title: "Return due tomorrow", message: `Return Mic 'A' ? $1 %_ \\ kit by ${tomorrow}.`, reason: null, request_id: a, read_at: null, created_at: undefined },
    { user_id: people[1].id, type: "due_soon", title: "Return due tomorrow", message: `Return Projector by ${tomorrow}.`, reason: null, request_id: b, read_at: null, created_at: undefined },
  ]);
  assert.match(rows[0].created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(await processDueReminders(h.appDb), 0);
  assert.equal(await processDueReminders(h.appDb, addDaysISO(today, 5)), 0, "nothing is due the day after a different today");
  assert.equal((await h.db.prepare("SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'due_soon'").get()).n, 3);
});

test("reminders: of two loans due, the one returned or cancelled between the scan and the insert gets none and the count is right", async (t) => {
  for (const change of [
    ["status = 'returned', returned_at = '2025-01-01T00:00:00.000Z'", "returned"],
    ["status = 'cancelled'", "cancelled"],
  ]) {
    let doomed;
    const { h, tomorrow, people, loan } = await loanSetup(t, (db) =>
      interleave(
        db,
        (sql) => sql.includes("n.type = 'due_soon'") && sql.includes("NOT EXISTS"),
        () => db.prepare(`UPDATE borrow_requests SET ${change[0]} WHERE id = ?`).run(doomed),
      ).wrapped,
    );
    doomed = await loan(people[0], "Gone item", tomorrow);
    const kept = await loan(people[1], "Kept item", tomorrow);
    assert.equal(await processDueReminders(h.appDb), 1, change[1]);
    const rows = await h.db.prepare("SELECT request_id FROM notifications WHERE type = 'due_soon'").all();
    assert.deepEqual(rows.map((r) => r.request_id), [kept], change[1]);
  }
});

test("reminders: a reminder another poll wrote between the scan and the insert is not duplicated and not counted twice", async (t) => {
  let first;
  const { h, tomorrow, people, loan } = await loanSetup(t, (db) =>
    interleave(
      db,
      (sql) => sql.includes("n.type = 'due_soon'") && sql.includes("NOT EXISTS"),
      () => db.prepare("INSERT INTO notifications (user_id, type, title, message, request_id) VALUES (?, 'due_soon', 'Return due tomorrow', 'by the other poll', ?)").run(people[0].id, first),
    ).wrapped,
  );
  first = await loan(people[0], "First", tomorrow);
  await loan(people[1], "Second", tomorrow);
  assert.equal(await processDueReminders(h.appDb), 1);
  assert.equal((await h.db.prepare("SELECT COUNT(*)::int AS n FROM notifications WHERE request_id = ? AND type = 'due_soon'").get(first)).n, 1);
});

test("reminders: many polls at once add exactly one reminder per loan, in total", async (t) => {
  const { h, tomorrow, people, loan } = await loanSetup(t);
  for (let i = 0; i < 6; i++) await loan(people[i % people.length], `Item ${i}`, tomorrow);
  const counts = await Promise.all(Array.from({ length: 8 }, () => processDueReminders(h.appDb)));
  assert.equal(counts.reduce((a, b) => a + b, 0), 6);
  assert.equal((await h.db.prepare("SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'due_soon'").get()).n, 6);
});

// --- 11. Admin backfill --------------------------------------------------------------------------------------------

test("backfill reads first and opens a transaction only when there is something to add", async (t) => {
  let transactions = 0;
  const h = await start(t, (db) => ({ ...db, transaction: (fn) => (transactions++, db.transaction(fn)) }));
  const student = await h.signup("lay.chantha@student.cadt.edu.kh");
  const camera = await h.item("Nikon camera");
  const lens = await h.item("Nikon lens");

  // Requests saved before the admin existed: no admin notices yet. Insert them straight into the table.
  const ids = [];
  for (const [item, created] of [[camera, "2025-01-02T00:00:00.000Z"], [lens, "2025-01-01T00:00:00.000Z"]]) {
    ids.push((await h.db.prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, created_at) VALUES (?, ?, '2030-01-01', '2030-01-08', ?) RETURNING id").run(item, student.id, created)).lastInsertRowid);
  }
  transactions = 0;
  assert.equal(await backfillAdminRequestNotifications(h.appDb, h.admin.id), 2);
  assert.equal(transactions, 1);
  const order = (await h.db.prepare("SELECT request_id FROM notifications WHERE user_id = ? ORDER BY id").all(h.admin.id)).map((r) => r.request_id);
  assert.deepEqual(order, [ids[1], ids[0]], "oldest request first, as before");

  transactions = 0;
  for (let i = 0; i < 3; i++) assert.equal(await backfillAdminRequestNotifications(h.appDb, h.admin.id), 0);
  assert.equal(transactions, 0, "nothing to add, so no transaction");
  assert.equal((await h.call("GET", "/api/notifications", h.admin.cookie)).status, 200);
  assert.equal(transactions, 0, "the bell load for an up-to-date admin opens none either");

  // A legacy notice without a request id counts as already told, so it is skipped and no transaction opens for it.
  const third = await h.item("Nikon flash");
  await h.db.prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, created_at) VALUES (?, ?, '2030-02-01', '2030-02-08', '2025-01-03T00:00:00.000Z')").run(third, student.id);
  const full = (await h.db.prepare("SELECT full_name FROM users WHERE id = ?").get(student.id)).full_name;
  await h.db.prepare("INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'request_submitted', 'Request submitted', ?)").run(h.admin.id, `New borrow request from ${full} for Nikon flash.`);
  transactions = 0;
  assert.equal(await backfillAdminRequestNotifications(h.appDb, h.admin.id), 0);
  assert.equal(transactions, 0);

  await assert.rejects(backfillAdminRequestNotifications(h.appDb, 0), TypeError);
  assert.equal(transactions, 0);
});

test("backfill: a notice another request wrote after the read is skipped by the unique index, the rest still land in one transaction", async (t) => {
  let adminId;
  let student;
  const ids = [];
  const h = await start(t, (db) =>
    interleave(
      db,
      (sql) => sql.includes("FROM borrow_requests r") && sql.includes("JOIN users u"),
      () =>
        db
          .prepare("INSERT INTO notifications (user_id, type, title, message, request_id) VALUES (?, 'request_submitted', 'Request submitted', 'by the request itself', ?)")
          .run(adminId, ids[0]),
    ).wrapped,
  );
  adminId = h.admin.id;
  student = await h.signup("hun.rithy@student.cadt.edu.kh");
  for (const name of ["One", "Two", "Three"]) {
    const item = await h.item(name);
    ids.push((await h.db.prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date) VALUES (?, ?, '2030-01-01', '2030-01-08') RETURNING id").run(item, student.id)).lastInsertRowid);
  }
  assert.equal(await backfillAdminRequestNotifications(h.appDb, h.admin.id), 2, "the raced one is not counted");
  const rows = await h.db.prepare("SELECT request_id FROM notifications WHERE user_id = ? AND type = 'request_submitted' ORDER BY request_id").all(h.admin.id);
  assert.deepEqual(rows.map((r) => r.request_id), ids);
});
