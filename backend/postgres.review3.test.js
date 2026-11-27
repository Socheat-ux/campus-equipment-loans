// Review round 3 of the SQLite to Postgres move (SCRUM-138). New cases only; nothing here repeats review1, fix1,
// review2, fix2 or copySqlite. Titles starting with DEFECT fail until the code is fixed. Real Postgres is not available:
// the pool cases use faked pg clients, and the folder lock cases use real processes on real PGlite folders.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { openDb, poolConfig, withTransaction } from "./db.js";

const dir = mkdtempSync(join(tmpdir(), "pg-review3-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const dbUrl = pathToFileURL(fileURLToPath(new URL("./db.js", import.meta.url))).href;
const DEAD_URL = "postgres://review3:s3cr3tpw-review3@127.0.0.1:1/review3"; // nothing listens on port 1
const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);

function childEnv() {
  const env = { ...process.env };
  for (const key of ["DATABASE_URL", "DATABASE_CA", "PGDATA_DIR", "NODE_ENV"]) delete env[key];
  return env;
}

// --- 1. TLS when the URL names the host more than once ------------------------------------------------------------------

test("guard: poolConfig: when host= is repeated, TLS follows the last one, which is the host pg really connects to", () => {
  // pg-connection-string copies every query parameter in order, so the last host= wins. A first-wins reading would
  // send the password in plain text to the remote host in the first two cases.
  const cases = [
    "postgres://u:p@db.example.com/app?host=localhost&host=db.example.com",
    "postgres://u:p@localhost/app?host=127.0.0.1&host=aws-0-ap-southeast-1.pooler.supabase.com",
    "postgres://u:p@db.example.com/app?host=db.example.com&host=localhost",
    "postgres://u:p@localhost/app?host=db.example.com&host=",
  ];
  for (const url of cases) {
    const cfg = poolConfig(url, undefined);
    const host = String(new pg.Client(cfg).connectionParameters.host).toLowerCase();
    assert.equal(cfg.ssl !== false, !LOCAL.has(host), `${url}: pg connects to ${host}, ssl is ${JSON.stringify(cfg.ssl)}`);
  }
});

// --- 2. pg transactions that fail before or at the end --------------------------------------------------------------------

function fakeClient(answer) {
  const client = new EventEmitter();
  client.sent = [];
  client.released = [];
  client.release = (err) => client.released.push(err);
  client.query = async (sql) => (client.sent.push(sql), answer(sql));
  return client;
}

test("pg transactions: a failed checkout, BEGIN or COMMIT reaches the caller, a dead client is dropped, and the next transaction still runs", async (t) => {
  const checkouts = [];
  t.mock.method(pg.Pool.prototype, "query", async () => ({ rows: [], rowCount: 0 }));
  t.mock.method(pg.Pool.prototype, "connect", async () => {
    const next = checkouts.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const db = await openDb(DEAD_URL);
  t.after(() => db.close());
  const work = (tx) => tx.prepare("UPDATE equipment SET available = available - 1 WHERE id = ?").run(1);

  // The pooler is full or slow: nothing was checked out, so nothing is released.
  checkouts.push(Object.assign(new Error("timeout exceeded when trying to connect"), { code: undefined }));
  await assert.rejects(withTransaction(db, work), /timeout exceeded/);

  // A pooled connection that died while idle: BEGIN and ROLLBACK both fail, so pg-pool must destroy it.
  const dead = fakeClient(() => Promise.reject(new Error("Connection terminated unexpectedly")));
  checkouts.push(dead);
  await assert.rejects(withTransaction(db, work), /Connection terminated unexpectedly/);
  assert.equal(dead.released.length, 1);
  assert.ok(dead.released[0] instanceof Error, "a client that could not even BEGIN is destroyed, not reused");

  // COMMIT refused (serialization failure): the work ran, but the caller must hear about the failure, never success.
  const serialization = Object.assign(new Error("could not serialize access"), { code: "40001" });
  const refused = fakeClient((sql) => (sql === "COMMIT" ? Promise.reject(serialization) : { rows: [], rowCount: 1 }));
  checkouts.push(refused);
  await assert.rejects(withTransaction(db, work), (err) => err.code === "40001");
  assert.deepEqual(refused.sent.slice(-2), ["COMMIT", "ROLLBACK"]);
  assert.deepEqual(refused.released, [undefined], "a connection that rolled back cleanly goes back to the pool");

  // None of the failures above left the nesting guard set: a fresh transaction runs and commits.
  const healthy = fakeClient(() => ({ rows: [{ id: 9 }], rowCount: 1 }));
  checkouts.push(healthy);
  assert.equal((await withTransaction(db, work)).changes, 1);
  assert.deepEqual([healthy.sent[0], healthy.sent.at(-1)], ["BEGIN", "COMMIT"]);
  for (const client of [dead, refused, healthy]) assert.equal(client.listenerCount("error"), 0);
});

// --- 3. One process per PGlite folder, with real processes ----------------------------------------------------------------

test("a lock whose owner is alive but cannot be signalled (EPERM) is never taken over", async () => {
  // pid 4 is the Windows System process; pid 1 is init elsewhere. Both are alive and belong to another user.
  const owner = process.platform === "win32" ? 4 : 1;
  const folder = join(dir, "eperm-owner");
  mkdirSync(folder);
  writeFileSync(join(folder, "app.lock"), `${owner}\n`);
  await assert.rejects(openDb(folder), (err) => err.message.includes(`process ${owner}`) && err.message.includes(folder));
  assert.equal(readFileSync(join(folder, "app.lock"), "utf8"), `${owner}\n`, "the owner's lock is untouched");
  assert.equal(existsSync(join(folder, "PG_VERSION")), false, "PGlite never started");
});

test("two processes racing for one fresh folder: one opens it, the other is refused naming it; killed hard, its committed row survives the takeover", async (t) => {
  const folder = join(dir, "race");
  const startAt = Date.now() + 1500; // both children are past their imports by then, so they really race
  const code = `
    import { openDb } from ${JSON.stringify(dbUrl)};
    while (Date.now() < ${startAt}) await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      const db = await openDb(${JSON.stringify(folder)});
      await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Lab', 1)").run("from " + process.pid);
      console.log("opened " + process.pid);
      setInterval(() => {}, 1000);
    } catch (err) {
      console.log("refused " + err.message);
      process.exit(0);
    }`;
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    child.out = "";
    child.stdout.on("data", (chunk) => (child.out += chunk));
    child.stderr.on("data", (chunk) => (child.out += chunk));
    t.after(() => child.exitCode === null && child.kill("SIGKILL"));
    return child;
  });
  const deadline = Date.now() + 60_000;
  while (!children.every((c) => /opened|refused/.test(c.out)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));

  const winners = children.filter((c) => c.out.startsWith("opened"));
  const losers = children.filter((c) => c.out.startsWith("refused"));
  assert.equal(winners.length, 1, children.map((c) => c.out).join("\n---\n"));
  assert.equal(losers.length, 1, children.map((c) => c.out).join("\n---\n"));
  const [winner] = winners;
  assert.match(losers[0].out, new RegExp(`in use by process ${winner.pid}\\b`));
  assert.equal(readFileSync(join(folder, "app.lock"), "utf8"), String(winner.pid));

  // Ctrl+C on Windows and a crash both end the process without running exit handlers.
  const exited = once(winner, "exit");
  winner.kill("SIGKILL");
  await exited;
  const db = await openDb(folder);
  t.after(() => db.close());
  assert.deepEqual((await db.prepare("SELECT name FROM equipment").all()).map((r) => r.name), [`from ${winner.pid}`]);
  assert.equal(readFileSync(join(folder, "app.lock"), "utf8"), String(process.pid));
});
