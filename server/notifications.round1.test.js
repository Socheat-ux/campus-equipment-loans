// Round 1 review of SCRUM-11. Tests marked DEFECT fail until the defect is fixed; the rest guard hard edges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, withTransaction } from "./db.js";
import { createApp } from "./app.js";
import { notify, LIST_LIMIT } from "./notifications.js";

const GOOD = "goodpass1";

async function start(t) {
  const db = openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, { body, cookie, type = "application/json", raw } = {}) =>
    fetch(`${root}${path}`, {
      method,
      headers: {
        ...(body === undefined && raw === undefined ? {} : { "Content-Type": type }),
        ...(cookie ? { cookie } : {}),
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  const signup = async (name) => {
    const res = await call("POST", "/api/auth/signup", { body: { email: `${name}@student.cadt.edu.kh`, password: GOOD } });
    assert.equal(res.status, 201);
    const { user } = await res.json();
    return { cookie: res.headers.get("set-cookie").split(";")[0], id: user.id };
  };
  const unreadInDb = (userId) => db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(userId).n;
  return { db, call, signup, unreadInDb };
}

// notify needs a transaction; callers inside withTransaction already have one.
const approve = (db, userId, message = "ok") => {
  const run = () => notify(db, { userId, type: "request_approved", message });
  return db.isTransaction ? run() : withTransaction(db, run);
};

// DEFECT: "npm run seed:test" is the only npm script that skips .env, so NODE_ENV=production set there
// does not stop it, and a production database gets test.admin@cadt.edu.kh with the public password.
test("DEFECT: npm run seed:test refuses when .env says NODE_ENV=production", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const [bin, ...args] = pkg.scripts["seed:test"].trim().split(/\s+/);
  assert.equal(bin, "node");
  const script = fileURLToPath(new URL("./seed-dev.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "seed-envfile-"));
  try {
    writeFileSync(join(dir, ".env"), "NODE_ENV=production\nDB_PATH=data/app.db\n");
    const env = { ...process.env };
    delete env.NODE_ENV;
    // Same command line as the npm script, run from a folder whose .env is the production one.
    const run = spawnSync(process.execPath, args.map((a) => (a === "server/seed-dev.js" ? script : a)), { cwd: dir, env, encoding: "utf8" });
    assert.notEqual(run.status, 0, `seed ran in production:\n${run.stdout}`);
    assert.equal(existsSync(join(dir, "data", "app.db")), false, "a production database was seeded with public test accounts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// DEFECT: an object without "ids" means "mark all", so a typo such as { id: 5 } or { notificationIds: [5] }
// silently marks every notification read instead of answering 400. So does an empty body sent as JSON.
test("DEFECT: mark-read with an unknown key is refused instead of marking everything", async (t) => {
  const { db, call, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  const keep = approve(db, a.id, "keep");
  approve(db, a.id, "also keep");
  for (const body of [{ id: keep }, { notificationIds: [keep] }, { IDS: [keep] }]) {
    const res = await call("POST", "/api/notifications/read", { cookie: a.cookie, body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  // An empty body sent as JSON (fetch with the header but no body) is read as {} and marks all.
  assert.equal((await call("POST", "/api/notifications/read", { cookie: a.cookie, raw: "" })).status, 400, "empty JSON body");
  assert.equal(unreadInDb(a.id), 2);
});

// DEFECT (low): ordering trusts the wall clock. If the clock steps back (NTP, VM resume) between two
// notifications, the newer one sorts below the older one. id is assigned in insert order and never lies.
test("DEFECT: newest first survives the server clock stepping backwards", async (t) => {
  const { db, call, signup } = await start(t);
  const a = await signup("sok.dara");
  const older = approve(db, a.id, "older");
  const newer = approve(db, a.id, "newer");
  db.prepare("UPDATE notifications SET created_at = '2026-11-12T08:00:05.000Z' WHERE id = ?").run(older);
  db.prepare("UPDATE notifications SET created_at = '2026-11-12T08:00:01.000Z' WHERE id = ?").run(newer); // clock read 4 s earlier
  const body = await (await call("GET", "/api/notifications", { cookie: a.cookie })).json();
  assert.deepEqual(body.notifications.map((n) => n.id), [newer, older]);
});

test("guard: a failure after notify rolls the notification back, and the API never shows it", async (t) => {
  const { db, call, signup } = await start(t);
  const a = await signup("sok.dara");
  db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Cam', 'Camera', 1)").run();
  assert.throws(() =>
    withTransaction(db, () => {
      approve(db, a.id, "ghost");
      db.prepare("UPDATE equipment SET quantity = -1").run(); // CHECK fails after the notice was written
    }),
  );
  assert.equal(db.isTransaction, false);
  const body = await (await call("GET", "/api/notifications", { cookie: a.cookie })).json();
  assert.deepEqual(body, { notifications: [], unread: 0 });
});

test("guard: nested withTransaction fails loudly and the outer work is undone", async (t) => {
  const { db, signup } = await start(t);
  const a = await signup("sok.dara");
  assert.throws(
    () =>
      withTransaction(db, () => {
        approve(db, a.id, "outer");
        withTransaction(db, () => approve(db, a.id, "inner"));
      }),
    /transaction within a transaction/,
  );
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 0);
});

test("guard: a mixed id list marks only the caller's rows, at the row level", async (t) => {
  const { db, call, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  const b = await signup("keo.bopha");
  const a1 = approve(db, a.id);
  const b1 = approve(db, b.id);
  const b2 = approve(db, b.id);
  const res = await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { ids: [b1, a1, b2, 2 ** 53 - 1, 1e300] } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { unread: 0 });
  assert.equal(unreadInDb(b.id), 2);
  const readAt = db.prepare("SELECT read_at FROM notifications WHERE id = ?").get(a1).read_at;
  assert.match(readAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  // A second mark does not move read_at: the first time it was read is kept.
  await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { ids: [a1] } });
  assert.equal(db.prepare("SELECT read_at FROM notifications WHERE id = ?").get(a1).read_at, readAt);
});

test("guard: query strings cannot widen the list or pick another user", async (t) => {
  const { db, call, signup } = await start(t);
  const a = await signup("sok.dara");
  const b = await signup("keo.bopha");
  for (let i = 0; i < LIST_LIMIT + 3; i++) approve(db, a.id, `a${i}`);
  approve(db, b.id, "secret of b");
  const res = await call("GET", `/api/notifications?user_id=${b.id}&userId=${b.id}&limit=100000`, { cookie: a.cookie });
  const body = await res.json();
  assert.equal(body.notifications.length, LIST_LIMIT);
  assert.ok(body.notifications.every((n) => n.message.startsWith("a")));
});

test("guard: an expired session can neither read nor mark, even with mark-all", async (t) => {
  const { db, call, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  approve(db, a.id);
  db.prepare("UPDATE sessions SET expires_at = ?").run(Date.now() - 1);
  assert.equal((await call("GET", "/api/notifications", { cookie: a.cookie })).status, 401);
  assert.equal((await call("POST", "/api/notifications/read", { cookie: a.cookie, body: {} })).status, 401);
  assert.equal(unreadInDb(a.id), 1);
});

test("guard: odd content types and oversized bodies never fall through to mark-all", async (t) => {
  const { db, call, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  approve(db, a.id);
  const post = (opts) => call("POST", "/api/notifications/read", { cookie: a.cookie, ...opts });
  assert.equal((await post({ raw: "{}", type: "text/plain" })).status, 415);
  assert.equal((await post({ raw: "{}", type: "application/vnd.api+json" })).status, 415);
  assert.equal((await post({ raw: "null" })).status, 400);
  assert.equal((await post({ raw: JSON.stringify({ ids: [1], pad: "x".repeat(20_000) }) })).status, 413);
  assert.equal(unreadInDb(a.id), 1);
  // charset parameter is still JSON
  assert.equal((await post({ raw: JSON.stringify({ all: true }), type: "application/json; charset=utf-8" })).status, 200);
  assert.equal(unreadInDb(a.id), 0);
});

test("guard: a reused user id does not inherit the deleted user's notices", async (t) => {
  const { db, call, signup } = await start(t);
  await signup("sok.dara");
  const last = await signup("keo.bopha");
  approve(db, last.id, "for the old owner");
  db.prepare("DELETE FROM users WHERE id = ?").run(last.id);
  const next = await signup("chan.nita");
  assert.equal(next.id, last.id); // SQLite hands the freed top id out again
  const body = await (await call("GET", "/api/notifications", { cookie: next.cookie })).json();
  assert.deepEqual(body, { notifications: [], unread: 0 });
});
