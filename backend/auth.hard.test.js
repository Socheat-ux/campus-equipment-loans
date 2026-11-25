import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { openDb } from "./db.js";
import { createApp } from "./app.js";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const GOOD = "goodpass1";

// Each test gets its own app, db and limiter, so tests cannot affect each other.
async function start(t, options) {
  const db = openDb(":memory:");
  const server = createApp(db, options).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  const post = (path, body, headers = {}) =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const get = (path, cookie) => fetch(base + path, { headers: cookie ? { cookie } : {} });
  return { db, base, post, get };
}
const cookieOf = (res) => res.headers.get("set-cookie").split(";")[0];

// node:test runs the tests of one file one after another, so changing process.env inside one test is safe.
async function withEnv(vars, fn) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test("two simultaneous signups for one email: one wins, one gets 409, server survives", async (t) => {
  const { post, get } = await start(t);
  const body = { email: "race.mary@student.cadt.edu.kh", password: GOOD };
  const results = await Promise.all([post("/signup", body), post("/signup", body)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await get("/me")).status, 401);
});

test("junk email is rejected before the rate limiter ever sees it", async (t) => {
  const { post } = await start(t);
  const res = await post("/login", { email: "z".repeat(9000) + "@x", password: GOOD });
  assert.equal(res.status, 400);
});

test("one address spraying many accounts gets limited", async (t) => {
  const { post } = await start(t, { ipFailures: 20 });
  const results = await Promise.all(
    Array.from({ length: 60 }, (_, i) => post("/login", { email: `user.x${i}@student.cadt.edu.kh`, password: GOOD })),
  );
  const statuses = results.map((r) => r.status);
  // 401 means the request got past validation and the limiter and reached the password check
  assert.ok(statuses.every((s) => s === 401 || s === 429), `unexpected statuses ${statuses}`);
  const limited = statuses.includes(429);
  assert.ok(limited, "60 logins for 60 different accounts from one address were never limited");
});

test("arrays and objects are not coerced into credentials", async (t) => {
  const { post } = await start(t);
  const arrays = await post("/signup", { email: ["chan.vy@student.cadt.edu.kh"], password: ["goodpass1"] });
  assert.equal(arrays.status, 400);
  assert.equal((await post("/signup", { email: {}, password: 12345678 })).status, 400);
  assert.equal((await post("/login", { email: ["chan.vy@student.cadt.edu.kh"], password: ["goodpass1"] })).status, 400);
});

test("a forged X-Forwarded-For does not dodge the limiter when TRUST_PROXY is unset", async (t) => {
  await withEnv({ NODE_ENV: "production", TRUST_PROXY: undefined }, async () => {
    const { post } = await start(t);
    const email = "victim.one@student.cadt.edu.kh";
    let last;
    for (let i = 1; i <= 12; i++) {
      last = await post("/login", { email, password: "wrongpass1" }, { "X-Forwarded-For": `203.0.113.${i}` });
    }
    assert.equal(last.status, 429);
  });
});

test("logout ends only the session that sent it", async (t) => {
  const { post, get } = await start(t);
  const body = { email: "two.devices@student.cadt.edu.kh", password: GOOD };
  const a = cookieOf(await post("/signup", body));
  const b = cookieOf(await post("/login", body));
  assert.notEqual(a, b);
  assert.equal((await post("/logout", {}, { cookie: a })).status, 204);
  assert.equal((await get("/me", a)).status, 401);
  assert.equal((await get("/me", b)).status, 200);
});

test("an expired session row is not accepted", async (t) => {
  const { db, post, get } = await start(t);
  await post("/signup", { email: "old.timer@student.cadt.edu.kh", password: GOOD });
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, ?)").run(sha256("expiredtok"), Date.now() - 1000);
  assert.equal((await get("/me", "sid=expiredtok")).status, 401);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, ?)").run(sha256("livetok"), Date.now() + 60000);
  assert.equal((await get("/me", "sid=livetok")).status, 200); // proves the row above was rejected for its date, not for some other reason
});

test("role and name come from the email only, never from the request", async (t) => {
  const { post } = await start(t);
  const evil = await post("/signup", { email: "o'neil.mary@cadt.edu.kh", password: GOOD, role: "admin", fullName: "Evil" });
  assert.equal(evil.status, 201);
  const { user } = await evil.json();
  assert.equal(user.role, "faculty");
  assert.equal(user.fullName, "O'Neil Mary");
  const hyphen = await post("/signup", { email: "nguyen-tran.an12@student.cadt.edu.kh", password: GOOD });
  assert.equal((await hyphen.json()).user.fullName, "Nguyen-Tran An");
  assert.equal((await post("/signup", { email: "nul.byte\0@student.cadt.edu.kh", password: GOOD })).status, 400);
});

test("cookie flags, body parse errors and content-type check", async (t) => {
  const { base, post } = await start(t);
  const signup = await post("/signup", { email: "flags.check@student.cadt.edu.kh", password: GOOD });
  const set = signup.headers.get("set-cookie");
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Lax/i);
  assert.match(set, /Path=\//i);
  assert.doesNotMatch(set, /Secure/i);

  await withEnv({ NODE_ENV: "production" }, async () => {
    const res = await post("/login", { email: "flags.check@student.cadt.edu.kh", password: GOOD });
    assert.match(res.headers.get("set-cookie"), /Secure/i);
  });

  const out = await post("/logout", {});
  const cleared = out.headers.get("set-cookie");
  assert.match(cleared, /^sid=;/);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970/i);

  const bad = await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '"hi"' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "Bad request." });

  const plain = await fetch(`${base}/logout`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
  assert.equal(plain.status, 415);
});

test("identity responses are never cached", async (t) => {
  const { post, get } = await start(t);
  const cookie = cookieOf(await post("/signup", { email: "no.cache@student.cadt.edu.kh", password: GOOD }));
  assert.match((await get("/me", cookie)).headers.get("cache-control"), /no-store/);
  assert.match((await get("/me")).headers.get("cache-control"), /no-store/); // the 401 too
});

test("a password typed with different Unicode composition still logs in", async (t) => {
  const { post } = await start(t);
  const email = "unicode.pw@student.cadt.edu.kh";
  await post("/signup", { email, password: "cafépass1" }); // precomposed e-acute
  assert.equal((await post("/login", { email, password: "cafépass1" })).status, 200); // e plus combining accent
});

test("nothing secret is stored in clear and the hash carries its parameters", async (t) => {
  const { db, post } = await start(t);
  const email = "at.rest@student.cadt.edu.kh";
  const password = "plainSecret42";
  const token = cookieOf(await post("/signup", { email, password })).slice("sid=".length);
  const { password_hash: hash } = db.prepare("SELECT password_hash FROM users").get();
  assert.match(hash, /^scrypt\$32768\$8\$3\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.ok(!hash.includes(password));
  const { token_hash } = db.prepare("SELECT token_hash FROM sessions").get();
  assert.equal(token_hash, sha256(token));
  assert.notEqual(token_hash, token);
  // same password, new account: the salt must differ, so the hashes differ
  await post("/signup", { email: "at.rest2@student.cadt.edu.kh", password });
  const [h1, h2] = db.prepare("SELECT password_hash FROM users ORDER BY id").all().map((r) => r.password_hash);
  assert.notEqual(h1, h2);
});

test("failed signups do not use up login attempts", async (t) => {
  const { post } = await start(t);
  const email = "separate.count@student.cadt.edu.kh";
  assert.equal((await post("/signup", { email, password: GOOD })).status, 201);
  for (let i = 0; i < 9; i++) assert.equal((await post("/signup", { email, password: GOOD })).status, 409);
  assert.equal((await post("/login", { email, password: GOOD })).status, 200);
});
