import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { DEMO_ACCOUNTS, DEMO_EQUIPMENT, DEMO_REQUESTS, seedDemo } from "./seed-demo.js";
import { TEST_PASSWORD } from "./seed-dev.js";
import { addDaysISO, BORROW_MAX_DAYS, displayName, roleFor } from "../shared/rules.js";

const script = fileURLToPath(new URL("./seed-demo.js", import.meta.url));
const PASSWORD = "demoPass2026";
const TODAY = "2026-12-03"; // the presentation day; the data is relative to whatever day is passed in

// Every row of every table except password hashes, which use a fresh salt each run.
async function snapshot(db) {
  const rows = {};
  for (const [table, order] of [["users", "id"], ["sessions", "token_hash"], ["equipment", "id"], ["borrow_requests", "id"], ["notifications", "id"]]) {
    rows[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()).map(({ password_hash, ...rest }) => rest);
  }
  return JSON.stringify(rows);
}

async function start(t, db) {
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password = PASSWORD) => {
    const res = await fetch(`${root}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    return { status: res.status, cookie: res.headers.get("set-cookie")?.split(";")[0] };
  };
  const get = async (path, cookie) => {
    const res = await fetch(root + path, { headers: { cookie } });
    return { status: res.status, text: await res.text() };
  };
  return { login, get };
}

test("a second run on the same day gives exactly the same rows, with ids from 1", async (t) => {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  const first = await seedDemo(db, PASSWORD, TODAY);
  const before = await snapshot(db);
  const second = await seedDemo(db, PASSWORD, TODAY);
  assert.deepEqual(second, first);
  assert.equal(await snapshot(db), before);
  assert.deepEqual(first, { users: DEMO_ACCOUNTS.length, equipment: DEMO_EQUIPMENT.length, requests: DEMO_REQUESTS.length, notifications: first.notifications });
  assert.equal((await db.prepare("SELECT MIN(id)::int AS m FROM users").get()).m, 1);
});

test("every request state is there, dates follow the day it runs, and stock matches the loans", async (t) => {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await seedDemo(db, PASSWORD, TODAY);
  const requests = await db.prepare("SELECT * FROM borrow_requests").all();
  const by = (status) => requests.filter((r) => r.status === status);
  for (const status of ["pending", "approved", "rejected", "returned", "cancelled"]) assert.ok(by(status).length > 0, status);
  const approved = by("approved");
  assert.ok(approved.some((r) => r.return_date > TODAY), "on loan");
  assert.ok(approved.some((r) => r.return_date === TODAY), "due today");
  assert.ok(approved.some((r) => r.return_date < TODAY), "overdue");
  assert.ok(by("pending").some((r) => r.borrow_date === TODAY), "a pending request starting today");
  assert.ok(by("pending").every((r) => r.borrow_date >= TODAY), "no pending request has a start date in the past");
  for (const r of requests) {
    assert.equal(r.return_date, addDaysISO(r.borrow_date, BORROW_MAX_DAYS), `request ${r.id} span`);
    assert.equal(Boolean(r.decided_by), r.status !== "pending" && !(r.status === "cancelled" && !r.decision_reason), `request ${r.id} decided_by`);
  }
  for (const r of by("rejected")) assert.ok(r.decision_reason, "a rejection carries its reason");
  for (const r of by("returned")) assert.ok(r.returned_at, "a returned loan has its return time");
  const pendingPairs = by("pending").map((r) => `${r.user_id}:${r.equipment_id}`);
  assert.equal(new Set(pendingPairs).size, pendingPairs.length, "one pending request per person and item");

  const items = await db.prepare(
    `SELECT e.name, e.quantity, e.available, (SELECT COUNT(*)::int FROM borrow_requests r WHERE r.equipment_id = e.id AND r.status = 'approved') AS out
     FROM equipment e`,
  ).all();
  for (const i of items) assert.equal(i.available, i.quantity - i.out, i.name);
  assert.ok(items.some((i) => i.quantity === 0), "an out-of-stock item");
  assert.ok(items.some((i) => i.quantity > 0 && i.available === 0), "an item with every copy on loan");
  assert.ok(new Set(DEMO_EQUIPMENT.map((e) => e.category)).size >= 5, "items across several categories");

  const admins = await db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
  assert.equal(admins.length, 2);
  const adminBorrows = await db.prepare("SELECT COUNT(*)::int AS n FROM borrow_requests r JOIN users u ON u.id = r.user_id WHERE u.role = 'admin'").get();
  assert.equal(adminBorrows.n, 0, "administrators never borrow");
});

test("emails and names follow the CADT rules, family name first", async () => {
  for (const { email, role } of DEMO_ACCOUNTS) {
    assert.equal(roleFor(email), role === "admin" ? "faculty" : role, email);
    assert.match(email, /^[a-z]+\.[a-z]+@(student\.)?cadt\.edu\.kh$/, email);
  }
  assert.equal(displayName("sok.dara@student.cadt.edu.kh"), "Sok Dara");
  assert.ok(DEMO_ACCOUNTS.some((a) => a.role === "faculty") && DEMO_ACCOUNTS.filter((a) => a.role === "student").length >= 3);
});

test("demo accounts log in with DEMO_PASSWORD, and the admin pages and CSV show the data", async (t) => {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await seedDemo(db, PASSWORD); // the real Cambodia day, as the server uses
  const { login, get } = await start(t, db);
  const admin = await login("chan.sokha@cadt.edu.kh");
  assert.equal(admin.status, 200);
  assert.equal((await login("sok.dara@student.cadt.edu.kh")).status, 200);
  assert.equal((await login("keo.sophal@cadt.edu.kh")).status, 200);
  assert.equal((await login("chan.sokha@cadt.edu.kh", TEST_PASSWORD)).status, 401, "the public test password opens nothing");

  const list = JSON.parse((await get("/api/admin/borrow-requests?status=all", admin.cookie)).text);
  for (const [status, n] of Object.entries(list.counts)) assert.ok(n > 0, `count for ${status}`);
  const overdue = JSON.parse((await get("/api/admin/overdue", admin.cookie)).text);
  assert.ok(overdue.overdue.length >= 2, "the overdue page has rows");
  const csv = await get("/api/admin/borrow-requests/export.csv?status=all", admin.cookie);
  assert.equal(csv.status, 200);
  assert.equal(csv.text.trim().split("\r\n").length, 1 + DEMO_REQUESTS.length, "header plus every request");
  const bell = JSON.parse((await get("/api/notifications", admin.cookie)).text);
  assert.ok(bell.notifications.length > 0 && bell.unread > 0, "the admin bell has new and old notices");
});

test("it refuses to delete real accounts, and a refused or failed run changes nothing", async (t) => {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await seedDemo(db, PASSWORD, TODAY);
  await db.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES ('mao.kanha@student.cadt.edu.kh', 'Mao Kanha', 'student', 'x')").run();
  const before = await snapshot(db);
  await assert.rejects(seedDemo(db, PASSWORD, TODAY), /1 account\(s\) here are not demo or test accounts/);
  assert.equal(await snapshot(db), before);
  for (const bad of [undefined, "", "short1", "longbutnodigits", TEST_PASSWORD]) {
    await assert.rejects(seedDemo(db, bad, TODAY), /DEMO_PASSWORD/, String(bad));
  }
  assert.equal(await snapshot(db), before);
});

test("the command refuses production, a live database without --remote and a missing password, before opening anything", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "seed-demo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, "pgdata");
  const base = { ...process.env, DEMO_PASSWORD: PASSWORD };
  delete base.DATABASE_URL;
  delete base.NODE_ENV;
  const cases = [
    [{ NODE_ENV: "production" }, /NODE_ENV=production/],
    [{ DATABASE_URL: "postgres://nobody:secret-pw@127.0.0.1:1/nodb" }, /DATABASE_URL is set/],
    [{ DEMO_PASSWORD: "" }, /Set DEMO_PASSWORD/],
  ];
  for (const [extra, message] of cases) {
    const run = spawnSync(process.execPath, [script, folder], { env: { ...base, ...extra }, encoding: "utf8" });
    assert.notEqual(run.status, 0, String(message));
    assert.match(run.stderr, message);
    assert.ok(!`${run.stdout}${run.stderr}`.includes("secret-pw"), "the database password is never printed");
  }
  assert.equal(existsSync(folder), false, "no database folder was created");

  const ok = spawnSync(process.execPath, [script, folder], { env: base, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /9 accounts, 10 items, 16 requests/);
  assert.ok(!`${ok.stdout}${ok.stderr}`.includes(PASSWORD), "the demo password is never printed");
});
