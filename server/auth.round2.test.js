import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { ipKey } from "./auth.js";

const GOOD = "goodpass1";
const WRONG = "wrongpass1";
const student = (name) => `${name}@student.cadt.edu.kh`;

// Every test builds its own app, db and limiter with small injected limits, so no state leaks between tests.
async function start(t, options) {
  const db = openDb(":memory:");
  const server = createApp(db, options).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = server.address().port;
  const root = `http://127.0.0.1:${port}`;
  const post = (path, body, headers = {}) =>
    fetch(`${root}/api/auth${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const get = (path, cookie) => fetch(`${root}/api/auth${path}`, { headers: cookie ? { cookie } : {} });
  return { db, port, root, post, get };
}
const tokenOf = (res) => res.headers.get("set-cookie").split(";")[0].slice("sid=".length);

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

test("a flood of junk emails does not reset an account lockout", async (t) => {
  // ipFailures is high on purpose: the flood must reach the full-map path, not be stopped by the address bucket.
  const { post } = await start(t, { maxKeys: 40, ipFailures: 100000, ipSuccesses: 100000 });
  const victim = student("flood.victim");
  assert.equal((await post("/signup", { email: victim, password: GOOD })).status, 201);
  for (let i = 0; i < 10; i++) assert.equal((await post("/login", { email: victim, password: WRONG })).status, 401);
  assert.equal((await post("/login", { email: victim, password: WRONG })).status, 429);

  let last;
  for (let batch = 0; batch < 6; batch++) {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post("/login", { email: student(`junk.n${batch * 20 + i}`), password: WRONG })),
    );
    last = results.at(-1).status;
  }
  assert.equal(last, 429, "the flood never filled the key map, so this test proves nothing");
  // locked before the flood, still locked after: even the right password is refused
  assert.equal((await post("/login", { email: victim, password: WRONG })).status, 429);
  assert.equal((await post("/login", { email: victim, password: GOOD })).status, 429);
});

test("successful logins are capped per address and do not use up the failure bucket", async (t) => {
  await withEnv({ TRUST_PROXY: "1" }, async () => {
    const { post } = await start(t, { ipFailures: 4, ipSuccesses: 6 });
    const email = student("many.logins");
    assert.equal((await post("/signup", { email, password: GOOD })).status, 201); // success 1 of 6
    // 5 more successes is more than ipFailures (4): if successes were counted as failures this would already be 429
    for (let i = 0; i < 5; i++) assert.equal((await post("/login", { email, password: GOOD })).status, 200);
    const over = await post("/login", { email, password: GOOD });
    assert.equal(over.status, 429, "the 7th success from one address was not capped");
    // the cap belongs to the address: the same account from another address still works
    assert.equal((await post("/login", { email, password: GOOD }, { "X-Forwarded-For": "198.51.100.9" })).status, 200);
  });
});

test("bulk signups from one address are capped", async (t) => {
  const { db, post } = await start(t, { ipSuccesses: 4 });
  for (let i = 0; i < 4; i++) assert.equal((await post("/signup", { email: student(`bulk.n${i}`), password: GOOD })).status, 201);
  assert.equal((await post("/signup", { email: student("bulk.n4"), password: GOOD })).status, 429);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 4);
});

test("weak-password and bad-email signups never use up attempts", async (t) => {
  const { post } = await start(t, { ipFailures: 5 });
  const email = student("weak.spammer");
  assert.equal((await post("/signup", { email, password: GOOD })).status, 201);
  const weak = await Promise.all(Array.from({ length: 12 }, (_, i) => post("/signup", { email: student(`weak.n${i}`), password: "short1" })));
  assert.ok(weak.every((r) => r.status === 400));
  assert.equal((await post("/login", { email, password: GOOD })).status, 200);
  // and a real signup still goes through afterwards
  assert.equal((await post("/signup", { email: student("weak.after"), password: GOOD })).status, 201);
});

test("the address failure bucket: strangers below the cap change nothing, at the cap the whole address is refused, other addresses are not", async (t) => {
  // Proves: (1) a stranger's wrong guesses do not stop a correct login while the address is under its cap,
  // (2) the cap is checked before the password, so once it is hit even a correct login from that address gets 429
  // (the accepted price of one shared campus address), (3) the lock is per address, not global.
  await withEnv({ TRUST_PROXY: "1" }, async () => {
    const { post } = await start(t, { ipFailures: 6 });
    const mine = student("honest.user");
    assert.equal((await post("/signup", { email: mine, password: GOOD })).status, 201);
    for (let i = 0; i < 3; i++) assert.equal((await post("/login", { email: student(`stranger.n${i}`), password: WRONG })).status, 401);
    assert.equal((await post("/login", { email: mine, password: GOOD })).status, 200); // 3 of 6 used, success hands its own back
    for (let i = 3; i < 6; i++) assert.equal((await post("/login", { email: student(`stranger.n${i}`), password: WRONG })).status, 401);
    assert.equal((await post("/login", { email: student("stranger.n6"), password: WRONG })).status, 429);
    assert.equal((await post("/login", { email: mine, password: GOOD })).status, 429);
    assert.equal((await post("/login", { email: mine, password: GOOD }, { "X-Forwarded-For": "198.51.100.20" })).status, 200);
  });
});

test("the per-email bucket counts across addresses", async (t) => {
  await withEnv({ TRUST_PROXY: "1" }, async () => {
    const { post } = await start(t, { emailFailures: 6 });
    const victim = student("shared.target");
    assert.equal((await post("/signup", { email: victim, password: GOOD })).status, 201);
    // six different addresses, one guess each: no IP+email bucket is near its limit of 10
    for (let i = 1; i <= 6; i++) {
      const res = await post("/login", { email: victim, password: WRONG }, { "X-Forwarded-For": `203.0.113.${i}` });
      assert.equal(res.status, 401);
    }
    const fresh = { "X-Forwarded-For": "203.0.113.200" };
    assert.equal((await post("/login", { email: victim, password: WRONG }, fresh)).status, 429);
    assert.equal((await post("/login", { email: victim, password: GOOD }, fresh)).status, 429); // accepted trade-off: the victim is locked too
    // another account from the same fresh address is untouched
    assert.equal((await post("/login", { email: student("shared.other"), password: WRONG }, fresh)).status, 401);
  });
});

test("ipKey groups IPv6 by /64 and keeps IPv4 as is", () => {
  assert.equal(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), ipKey("2001:db8:1:2::1"));
  assert.equal(ipKey("2001:db8:1:2:0:0:0:1"), ipKey("2001:0DB8:0001:0002::ffff"));
  assert.notEqual(ipKey("2001:db8:1:2::1"), ipKey("2001:db8:1:3::1"));
  assert.notEqual(ipKey("2001:db8:1:2::1"), ipKey("2001:db9:1:2::1"));
  assert.equal(ipKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("::1"), ipKey("::2")); // short compressed forms still reduce to their first four groups
  assert.notEqual(ipKey("::1"), ipKey("2001:db8::1"));
  assert.equal(ipKey("fe80::1%eth0"), ipKey("fe80::2"));
});

test("sessions per user are capped and the oldest goes first", async (t) => {
  const { db, post, get } = await start(t, { maxSessionsPerUser: 3 });
  const email = student("many.devices");
  const tokens = [tokenOf(await post("/signup", { email, password: GOOD }))];
  for (let i = 0; i < 4; i++) tokens.push(tokenOf(await post("/login", { email, password: GOOD })));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 1").get().n, 3);
  assert.equal((await get("/me", `sid=${tokens[0]}`)).status, 401);
  assert.equal((await get("/me", `sid=${tokens[1]}`)).status, 401);
  assert.equal((await get("/me", `sid=${tokens[2]}`)).status, 200);
  assert.equal((await get("/me", `sid=${tokens[4]}`)).status, 200);
  // another user's sessions are not touched by this user's cap
  const other = tokenOf(await post("/signup", { email: student("one.device"), password: GOOD }));
  assert.equal((await get("/me", `sid=${other}`)).status, 200);
});

// A raw request, because fetch would normalize "/%2e%2e/" into "/" before sending.
const raw = (port, path) =>
  new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("latin1");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    })
      .on("error", reject)
      .end();
  });

test("the static route does not serve source or data files", { skip: !existsSync(new URL("../dist", import.meta.url)) }, async (t) => {
  const { port } = await start(t);
  for (const path of ["/..%2fpackage.json", "/%2e%2e/server/app.js", "/%2e%2e%5cdata%5capp.db", "/..%5cpackage.json", "/%2e%2e/%2e%2e/package.json"]) {
    const res = await raw(port, path);
    for (const secret of ["campus-equipment-loans", "createApp", "SQLite format"]) {
      assert.ok(!res.body.includes(secret), `${path} leaked "${secret}"`);
    }
  }
});

test("email boundaries", async (t) => {
  const { post } = await start(t);
  const long = (n) => `${"a".repeat(Math.floor((n - 21) / 2))}.${"b".repeat(n - 21 - Math.floor((n - 21) / 2))}@student.cadt.edu.kh`;
  assert.equal(long(254).length, 254);
  assert.equal(long(255).length, 255);
  assert.equal((await post("/signup", { email: long(254), password: GOOD })).status, 201);
  assert.equal((await post("/signup", { email: long(255), password: GOOD })).status, 400);
  assert.equal((await post("/signup", { email: student("digits.max999"), password: GOOD })).status, 201);
  assert.equal((await post("/signup", { email: student("digits.max1000"), password: GOOD })).status, 400);
  for (const email of [
    "ｈong.bonsak@student.cadt.edu.kh", // fullwidth h
    "hong.bon​sak@student.cadt.edu.kh", // zero-width space
    "hong.bonsak@student.cadt.edu.kh.", // trailing dot
  ]) {
    assert.equal((await post("/signup", { email, password: GOOD })).status, 400, JSON.stringify(email));
    assert.equal((await post("/login", { email, password: GOOD })).status, 400, JSON.stringify(email));
  }
});

test("only a well-formed sid cookie signs you in", async (t) => {
  const { post, get } = await start(t);
  const token = tokenOf(await post("/signup", { email: student("cookie.edge"), password: GOOD }));
  assert.equal((await get("/me", `sid=${token}`)).status, 200);
  assert.equal((await get("/me", `sid=${token}junk`)).status, 401);
  assert.equal((await get("/me", `sid="${token}"`)).status, 401);
  assert.equal((await get("/me", `sid=${token.slice(0, -1)}`)).status, 401);
  assert.equal((await get("/me", `xsid=bad; sid=${token}`)).status, 200);
  assert.equal((await get("/me", `xsid=${token}`)).status, 401);
});

test("a burst of simultaneous logins all finish and the server stays responsive (scrypt gate)", async (t) => {
  // No test hook into the gate: this checks the outcome. 12 logins at once queue behind 2 scrypt slots,
  // while a cheap API call and a static file must still be answered quickly.
  const { post, get, root } = await start(t, { accountFailures: 20 }); // attempts are counted before the password check, 12 at once would pass the default 10
  const email = student("burst.user");
  assert.equal((await post("/signup", { email, password: GOOD })).status, 201);
  const burst = Promise.all(Array.from({ length: 12 }, () => post("/login", { email, password: GOOD })));
  await new Promise((r) => setTimeout(r, 50));
  // Relative, not a clock limit: the quick calls must be answered while logins are still queued, however slow the machine is.
  let burstDone = false;
  burst.then(() => (burstDone = true));
  assert.equal((await get("/me")).status, 401);
  if (existsSync(new URL("../dist", import.meta.url))) assert.equal((await fetch(`${root}/`)).status, 200);
  assert.equal(burstDone, false, "the quick calls were only answered after the whole burst finished");
  assert.ok((await burst).every((r) => r.status === 200));
});

test("a lockout ends when the window ends", async (t) => {
  // One wrong guess is the only scrypt run before the lockout, so a loaded machine cannot let the window run out first.
  const windowMs = 4000;
  const { post } = await start(t, { accountFailures: 1, windowMs });
  const email = student("window.user");
  assert.equal((await post("/signup", { email, password: GOOD })).status, 201);
  const first = Date.now(); // the login counter starts at the first login attempt, which is at or after this
  assert.equal((await post("/login", { email, password: WRONG })).status, 401);
  const locked = await post("/login", { email, password: GOOD });
  assert.ok(Date.now() - first < windowMs - 500, "machine too slow: the window ended before the lockout could be checked");
  assert.equal(locked.status, 429);
  await new Promise((r) => setTimeout(r, Math.max(0, first + windowMs + 300 - Date.now())));
  assert.equal((await post("/login", { email, password: GOOD })).status, 200);
});
