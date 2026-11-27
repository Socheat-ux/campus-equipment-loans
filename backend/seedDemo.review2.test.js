// Review round 2 of the demo seed (SCRUM-74). New cases only; nothing here repeats seedDemo.test.js, seedDemo.review1.test.js
// or seedDemo.fix1.test.js. The lock and deadlock behaviour needs two real Postgres connections, so it was checked on a
// throwaway local Postgres 18 outside this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { DEMO_ACCOUNTS, seedDemo } from "./seed-demo.js";
import { addDaysISO, BORROW_MAX_DAYS, borrowDateError, purposeError, rejectionReasonError, todayISO } from "../shared/rules.js";

const seedScript = fileURLToPath(new URL("./seed-demo.js", import.meta.url));
const devScript = fileURLToPath(new URL("./seed-dev.js", import.meta.url));
const PASSWORD = "reviewTwo2026";
const TODAY = "2026-12-03";
const phnomPenhDay = (iso) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Phnom_Penh" });
const sqlToIso = (text) => `${text.replace(" ", "T")}.000Z`;

async function serve(t, db) {
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, cookie, body) => {
    const res = await fetch(root + path, {
      method,
      headers: { cookie: cookie ?? "", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.startsWith("{") ? JSON.parse(text) : undefined };
  };
  const login = async (email) => {
    const res = await fetch(`${root}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    await res.text();
    return res.headers.get("set-cookie")?.split(";")[0];
  };
  return { call, login };
}

// Rebuilds every step each request went through from its row and its notices, then plays the steps in time order
// through the rules the routes enforce. Returns the broken rules, one line each.
async function replay(db, today) {
  const problems = [];
  const users = new Map((await db.prepare("SELECT * FROM users").all()).map((u) => [u.id, u]));
  const items = new Map((await db.prepare("SELECT * FROM equipment").all()).map((e) => [e.id, e]));
  const requests = await db.prepare("SELECT * FROM borrow_requests ORDER BY id").all();
  const notices = await db.prepare("SELECT * FROM notifications ORDER BY id").all();
  const admins = [...users.values()].filter((u) => u.role === "admin");
  const isAdmin = (id) => admins.some((a) => a.id === id);
  const events = [];

  for (const r of requests) {
    const u = users.get(r.user_id);
    const e = items.get(r.equipment_id);
    const tag = `${today} #${r.id} ${u.email} ${e.name} ${r.status}`;
    const mine = notices.filter((n) => n.request_id === r.id);
    const own = (type) => mine.filter((n) => n.user_id === r.user_id && n.type === type);
    // The exact words and moment of each notice, as the route that reports the step writes it.
    const expect = (type, message, at, reason = null) => {
      const found = own(type);
      if (found.length !== 1) return problems.push(`${tag}: ${found.length} ${type} notices`);
      const [n] = found;
      if (n.message !== message) problems.push(`${tag}: ${type} says "${n.message}", the app says "${message}"`);
      if (n.created_at !== at) problems.push(`${tag}: ${type} at ${n.created_at}, the step at ${at}`);
      if (n.reason !== reason) problems.push(`${tag}: ${type} reason ${n.reason}`);
      return n;
    };
    let expected = 1 + admins.length;
    expect("request_submitted", `Your request for ${e.name} was submitted and is awaiting approval.`, r.created_at);
    for (const a of admins) {
      const told = mine.filter((n) => n.user_id === a.id);
      const message = `New borrow request from ${u.full_name || u.email} for ${e.name}.`;
      if (told.length !== 1 || told[0].type !== "request_submitted" || told[0].message !== message || told[0].created_at !== r.created_at) {
        problems.push(`${tag}: admin ${a.email} was not told once, at the moment it was asked, in the app's words`);
      }
    }
    events.push({ at: r.created_at, kind: "create", r, tag });

    const approval = own("request_approved")[0];
    if (approval) {
      expected += 1;
      const message = `Request approved. ${e.name} is ready for pickup at ${e.location} on ${r.borrow_date}; return by ${addDaysISO(r.borrow_date, BORROW_MAX_DAYS)}.`;
      expect("request_approved", message, approval.created_at);
      events.push({ at: approval.created_at, kind: "approve", r, tag });
    }
    if (r.status === "rejected") {
      expected += 1;
      expect("request_rejected", `Request rejected. ${e.name}. See the reason in My requests.`, r.decided_at, r.decision_reason);
      events.push({ at: r.decided_at, kind: "reject", r, tag });
    }
    if (r.status === "returned") {
      expected += 1;
      expect("request_returned", `Equipment returned: ${e.name}.`, r.returned_at);
      events.push({ at: r.returned_at, kind: "return", r, tag });
    }
    if (r.status === "cancelled") {
      expected += 1;
      const byAdmin = r.decided_by !== null;
      const message = byAdmin
        ? `Your request for ${e.name} was cancelled by an administrator.${r.decision_reason ? ` Reason: ${r.decision_reason}` : ""}`.slice(0, 300)
        : `Your request for ${e.name} was cancelled.`;
      const n = own("request_cancelled")[0];
      expect("request_cancelled", message, byAdmin ? r.decided_at : n?.created_at);
      events.push({ at: n?.created_at, kind: byAdmin ? "adminCancel" : "studentCancel", r, tag });
    }
    if (mine.length !== expected) problems.push(`${tag}: ${mine.length} notices, its steps explain ${expected}`);
  }
  const stray = notices.filter((n) => n.request_id === null || !requests.some((r) => r.id === n.request_id));
  if (stray.length) problems.push(`${today}: ${stray.length} notices belong to no request`);

  // Takes before releases at the same instant, so a tie can never hide a shortage.
  const order = { create: 0, approve: 1, reject: 2, studentCancel: 2, adminCancel: 3, return: 3 };
  events.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : order[x.kind] - order[y.kind]));
  const shelf = new Map([...items.values()].map((e) => [e.id, e.quantity]));
  const state = new Map();
  for (const { at, kind, r, tag } of events) {
    const step = `${tag} ${kind} at ${at}`;
    if (!at) {
      problems.push(`${step}: no time`);
      continue;
    }
    if (phnomPenhDay(at) >= today) problems.push(`${step}: not on a day before ${today} in Phnom Penh`);
    if (at < sqlToIso(users.get(r.user_id).created_at) || at < sqlToIso(items.get(r.equipment_id).created_at)) {
      problems.push(`${step}: before the account or the item existed`);
    }
    const now = state.get(r.id);
    const left = shelf.get(r.equipment_id);
    if (kind === "create") {
      if (!["student", "faculty"].includes(users.get(r.user_id).role)) problems.push(`${step}: only students and faculty may ask`);
      if (borrowDateError(r.borrow_date, phnomPenhDay(at))) problems.push(`${step}: asked for a start date already past`);
      if (r.return_date !== addDaysISO(r.borrow_date, BORROW_MAX_DAYS)) problems.push(`${step}: return date is not borrow + ${BORROW_MAX_DAYS}`);
      if (purposeError(r.purpose)) problems.push(`${step}: purpose fails the form rule`);
      if (left < 1) problems.push(`${step}: asked while none was on the shelf, which the app refuses`);
      const twin = requests.find((o) => o.id !== r.id && state.get(o.id) === "pending" && o.user_id === r.user_id && o.equipment_id === r.equipment_id);
      if (twin) problems.push(`${step}: a second pending request beside #${twin.id}`);
      state.set(r.id, "pending");
    } else if (kind === "approve") {
      if (now !== "pending") problems.push(`${step}: approved while ${now}`);
      if (r.borrow_date < phnomPenhDay(at)) problems.push(`${step}: approved after the start date passed`);
      if (left < 1) problems.push(`${step}: approved with none on the shelf`);
      if (!isAdmin(r.decided_by) || r.decided_by === r.user_id) problems.push(`${step}: not decided by another administrator`);
      if (["approved", "returned"].includes(r.status) && r.decided_at !== at) problems.push(`${step}: decided_at ${r.decided_at} is not the approval`);
      shelf.set(r.equipment_id, left - 1);
      state.set(r.id, "approved");
    } else if (kind === "reject") {
      if (now !== "pending") problems.push(`${step}: rejected while ${now}`);
      if (!isAdmin(r.decided_by)) problems.push(`${step}: not rejected by an administrator`);
      if (rejectionReasonError(r.decision_reason)) problems.push(`${step}: reason fails the form rule`);
      state.set(r.id, "rejected");
    } else if (kind === "studentCancel") {
      if (now !== "pending") problems.push(`${step}: a student can only cancel a pending request, this one was ${now}`);
      if (r.decided_at !== null || r.decision_reason !== null) problems.push(`${step}: a student cancel records no decision`);
      state.set(r.id, "cancelled");
    } else if (kind === "adminCancel") {
      if (!["approved", "rejected"].includes(now)) problems.push(`${step}: an administrator cancels only approved or rejected requests, this one was ${now}`);
      if (!isAdmin(r.decided_by)) problems.push(`${step}: not cancelled by an administrator`);
      if (now === "approved") {
        if (left + 1 > items.get(r.equipment_id).quantity) problems.push(`${step}: more on the shelf than the store owns`);
        shelf.set(r.equipment_id, left + 1);
      }
      state.set(r.id, "cancelled");
    } else if (kind === "return") {
      if (now !== "approved") problems.push(`${step}: returned while ${now}`);
      if (phnomPenhDay(at) < r.borrow_date) problems.push(`${step}: back before it went out`);
      if (left + 1 > items.get(r.equipment_id).quantity) problems.push(`${step}: more on the shelf than the store owns`);
      shelf.set(r.equipment_id, left + 1);
      state.set(r.id, "returned");
    }
  }
  for (const r of requests) if (state.get(r.id) !== r.status) problems.push(`${today} #${r.id}: the steps end at ${state.get(r.id)}, the row says ${r.status}`);
  for (const e of items.values()) if (shelf.get(e.id) !== e.available) problems.push(`${today} ${e.name}: the steps leave ${shelf.get(e.id)} on the shelf, the row says ${e.available}`);
  return problems;
}

test("guard: played back in time order, every seeded step obeys the rule its route enforces, on any day of the year", async (t) => {
  // A stock count that is right at the end can still have gone below zero on the way, and a notice can name the wrong loan;
  // only the whole history shows that. Year end, leap day, month ends and the real day.
  for (const today of [TODAY, "2026-12-31", "2027-01-01", "2027-03-01", "2028-02-29", "2028-03-01", todayISO()]) {
    const db = await openDb(":memory:");
    t.after(() => db.close());
    await seedDemo(db, PASSWORD, today);
    assert.deepEqual(await replay(db, today), [], today);
  }
});

test("guard: the account check and the reset run in one transaction, and nothing touches the database outside it", async (t) => {
  // On Postgres the check only protects anyone if it shares the transaction (and the lock) with TRUNCATE.
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await seedDemo(db, PASSWORD, TODAY);
  const outside = [];
  let transactions = 0;
  const watched = {
    isTransaction: false,
    prepare: (sql) => (outside.push(sql), db.prepare(sql)),
    exec: (sql) => (outside.push(sql), db.exec(sql)),
    transaction: (fn) => (transactions++, db.transaction(fn)),
  };

  await seedDemo(watched, PASSWORD, addDaysISO(TODAY, 1));
  assert.deepEqual([outside, transactions], [[], 1], "a successful reset");

  await db.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES ('mao.kanha@student.cadt.edu.kh', 'Mao Kanha', 'student', 'x')").run();
  transactions = 0;
  await assert.rejects(seedDemo(watched, PASSWORD, TODAY), /Refusing/);
  assert.deepEqual([outside, transactions], [[], 1], "a refused reset");

  transactions = 0;
  await assert.rejects(seedDemo(watched, "short1", TODAY), /DEMO_PASSWORD/);
  assert.deepEqual([outside, transactions], [[], 0], "a weak password is refused before any database work");
});

test("guard: on a local folder the command refuses another DEMO_PASSWORD, names all nine accounts, leaves the folder as it was and free, and seed:test accounts never block", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "seed-demo-r2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, "pgdata");
  const env = { ...process.env };
  for (const key of ["DATABASE_URL", "NODE_ENV", "PGDATA_DIR", "DEMO_PASSWORD"]) delete env[key];
  const run = (script, password, ...args) =>
    spawnSync(process.execPath, [script, folder, ...args], { env: password ? { ...env, DEMO_PASSWORD: password } : env, encoding: "utf8", timeout: 120_000 });
  // Opening the folder in this process also proves the command released its lock.
  const dump = async () => {
    const db = await openDb(folder);
    try {
      const rows = {};
      for (const table of ["users", "sessions", "equipment", "borrow_requests", "notifications"]) rows[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
      return rows;
    } finally {
      await db.close();
    }
  };

  const first = run(seedScript, "FirstDemo2026");
  assert.equal(first.status, 0, first.stderr);
  const before = await dump();

  const other = run(seedScript, "SecondDemo2026");
  assert.equal(other.status, 1, other.stdout);
  for (const { email } of DEMO_ACCOUNTS) assert.ok(other.stderr.includes(email), `${email} is named`);
  assert.match(other.stderr, /Nothing was changed/);
  assert.doesNotMatch(other.stdout, /Demo data in/);
  assert.ok(!`${other.stdout}${other.stderr}`.includes("Demo2026"), "neither password is printed");
  assert.deepEqual(await dump(), before, "the refused run changed nothing on disk");

  const dev = run(devScript, null);
  assert.equal(dev.status, 0, dev.stderr);
  const again = run(seedScript, "FirstDemo2026", "--remote"); // --remote without DATABASE_URL still means the folder
  assert.equal(again.status, 0, again.stderr);
  const after = await dump();
  assert.deepEqual(after.users.map((u) => u.email), DEMO_ACCOUNTS.map((a) => a.email));
  assert.deepEqual(after.borrow_requests, before.borrow_requests, "same day, same requests, the seed:test loan gone");
});

test("guard: a reset in the middle of live traffic leaves every demo row exactly as a clean run writes it, and only later actions add rows", async (t) => {
  const today = todayISO();
  const clean = await openDb(":memory:");
  t.after(() => clean.close());
  await seedDemo(clean, PASSWORD, today);
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await seedDemo(db, PASSWORD, today);
  const { call, login } = await serve(t, db);
  const admin = await login("chan.sokha@cadt.edu.kh");
  const student = await login("sok.dara@student.cadt.edu.kh");
  const cable = (await db.prepare("SELECT id FROM equipment WHERE name = 'HDMI Cable 3 m'").get()).id;

  // A rehearsal the reset must wipe: a new request, approved.
  const asked = await call("POST", "/api/borrow-requests", student, { equipmentId: cable, borrowDate: today, purpose: "Rehearsal" });
  assert.equal(asked.status, 201);
  assert.equal((await call("POST", `/api/admin/borrow-requests/${asked.json.request.id}/approve`, admin, {})).status, 200);

  const started = new Date().toISOString();
  const traffic = [
    call("GET", "/api/notifications", admin),
    call("GET", "/api/notifications", student),
    call("POST", "/api/borrow-requests", student, { equipmentId: cable, borrowDate: addDaysISO(today, 1) }),
    login("pich.sopheap@cadt.edu.kh"),
    call("GET", "/api/admin/borrow-requests?status=all", admin),
    login("noun.sovann@student.cadt.edu.kh"),
    call("GET", "/api/notifications", admin),
    call("GET", "/api/admin/overdue", admin),
  ];
  const [reset, ...served] = await Promise.allSettled([seedDemo(db, PASSWORD, today), ...traffic]);
  assert.equal(reset.status, "fulfilled", reset.reason?.message);
  assert.ok(served.every((s) => s.status === "fulfilled"), "every request got an answer");
  assert.ok(await login("phan.rithy@student.cadt.edu.kh"), "the server still serves");
  assert.equal((await call("GET", "/api/auth/me", admin)).status, 401, "a cookie from before the reset is dead");

  const strip = ({ password_hash, ...rest }) => rest;
  for (const table of ["users", "equipment", "borrow_requests", "notifications"]) {
    const want = (await clean.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).map(strip);
    const got = (await db.prepare(`SELECT * FROM ${table} WHERE id <= ? ORDER BY id`).all(want.length)).map(strip);
    assert.deepEqual(got, want, `${table}: the demo rows`);
  }
  const counts = async (table) => (await db.prepare(`SELECT COUNT(*)::int AS n FROM ${table}`).get()).n;
  assert.equal(await counts("users"), DEMO_ACCOUNTS.length);
  assert.equal(await counts("equipment"), (await clean.prepare("SELECT COUNT(*)::int AS n FROM equipment").get()).n);
  const demoRequests = (await clean.prepare("SELECT COUNT(*)::int AS n FROM borrow_requests").get()).n;
  const demoNotices = (await clean.prepare("SELECT COUNT(*)::int AS n FROM notifications").get()).n;
  for (const r of await db.prepare("SELECT r.*, u.email FROM borrow_requests r JOIN users u ON u.id = r.user_id WHERE r.id > ?").all(demoRequests)) {
    assert.ok(r.status === "pending" && r.email === "sok.dara@student.cadt.edu.kh" && r.created_at >= started, `extra request ${r.id} came from the live request`);
  }
  for (const n of await db.prepare("SELECT * FROM notifications WHERE id > ?").all(demoNotices)) {
    assert.ok(["due_soon", "request_submitted"].includes(n.type) && n.created_at >= started, `extra notice ${n.id} (${n.type})`);
    assert.ok(n.request_id && (await db.prepare("SELECT 1 FROM borrow_requests WHERE id = ?").get(n.request_id)), `extra notice ${n.id} points at a request that exists`);
  }
  const drift = await db.prepare(
    "SELECT name FROM equipment e WHERE available <> quantity - (SELECT COUNT(*) FROM borrow_requests r WHERE r.equipment_id = e.id AND r.status = 'approved')",
  ).all();
  assert.deepEqual(drift, []);
});
