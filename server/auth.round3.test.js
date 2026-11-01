import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb } from "./db.js";
import { createApp } from "./app.js";

const GOOD = "goodpass1";
const WRONG = "wrongpass1";
const student = (name) => `${name}@student.cadt.edu.kh`;

async function start(t, options) {
  const db = openDb(":memory:");
  const server = createApp(db, options).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, signal) =>
    fetch(`${root}/api/auth${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const postWithin = (ms, path, body) => post(path, body, AbortSignal.timeout(ms));
  const get = (path, cookie) => fetch(`${root}/api/auth${path}`, { headers: cookie ? { cookie } : {} });
  return { db, post, postWithin, get };
}

test("refused requests do not use up the success bucket", async (t) => {
  const { post } = await start(t, { accountFailures: 2, ipSuccesses: 3 });
  assert.equal((await post("/signup", { email: student("sok.dara"), password: GOOD })).status, 201);
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await post("/login", { email: student("chan.vibol"), password: WRONG })).status);
  assert.deepEqual(statuses, [401, 401, 429, 429, 429, 429]);
  assert.equal((await post("/login", { email: student("sok.dara"), password: GOOD })).status, 200);
});

test("cancelled queued guesses do not delay a real login", async (t) => {
  const { post } = await start(t, { scryptConcurrency: 1 });
  const login = { email: student("sok.dara"), password: GOOD };
  assert.equal((await post("/signup", login)).status, 201);
  let began = performance.now();
  assert.equal((await post("/login", login)).status, 200);
  const single = performance.now() - began;

  const ctl = new AbortController();
  const guesses = Array.from({ length: 20 }, (_, i) =>
    post("/login", { email: student(`ghost.a${String.fromCharCode(97 + i)}`), password: WRONG }, ctl.signal).catch(() => null),
  );
  setTimeout(() => ctl.abort(), 50);
  await Promise.all(guesses);

  began = performance.now();
  assert.equal((await post("/login", login)).status, 200);
  const after = performance.now() - began;
  assert.ok(after < Math.max(3 * single, 4000), `login took ${Math.round(after)} ms after cancelled guesses, one login alone takes ${Math.round(single)} ms`);
});

test("bad options are rejected when the app is created", () => {
  const db = openDb(":memory:");
  for (const bad of [{ maxSessionsPerUser: 0 }, { maxSessionsPerUser: NaN }, { scryptConcurrency: 0 }, { ipFailures: -1 }]) {
    assert.throws(() => createApp(db, bad), TypeError, JSON.stringify(bad));
  }
  createApp(db);
  createApp(db, {});
});

test("a hash job that throws gives its gate slot back", async (t) => {
  const { db, post, postWithin } = await start(t, { scryptConcurrency: 1 });
  for (const n of ["sok.dara", "keo.bopha"]) assert.equal((await post("/signup", { email: student(n), password: GOOD })).status, 201);
  db.prepare("UPDATE users SET password_hash='scrypt$x$y$z$$' WHERE email=?").run(student("keo.bopha"));
  for (let i = 0; i < 3; i++) {
    const res = await post("/login", { email: student("keo.bopha"), password: GOOD });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Server error." });
  }
  // A lost slot would hang this request forever, so it gets a generous deadline instead of a speed bound.
  assert.equal((await postWithin(20000, "/login", { email: student("sok.dara"), password: GOOD })).status, 200);
});

test("your own successful logins do not buy extra guesses at someone else", async (t) => {
  const { post } = await start(t, { accountFailures: 3 });
  for (const n of ["sok.dara", "keo.bopha"]) assert.equal((await post("/signup", { email: student(n), password: GOOD })).status, 201);
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    statuses.push((await post("/login", { email: student("keo.bopha"), password: WRONG })).status);
    assert.equal((await post("/login", { email: student("sok.dara"), password: GOOD })).status, 200);
  }
  assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  assert.equal((await post("/login", { email: student("keo.bopha"), password: GOOD })).status, 429);
});

test("many logins at once for one user respect the session cap", async (t) => {
  const { db, post, get } = await start(t, { maxSessionsPerUser: 2 });
  const login = { email: student("sok.dara"), password: GOOD };
  assert.equal((await post("/signup", login)).status, 201);
  const results = await Promise.all(Array.from({ length: 6 }, () => post("/login", login)));
  for (const r of results) assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n, 2);
  const me = await Promise.all(results.map((r) => get("/me", r.headers.get("set-cookie").split(";")[0]).then((m) => m.status)));
  assert.equal(me.filter((s) => s === 200).length, 2);
  assert.equal(me.filter((s) => s === 401).length, 4);
});
