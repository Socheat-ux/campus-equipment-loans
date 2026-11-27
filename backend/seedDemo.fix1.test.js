// Fix round 1 of the demo seed (SCRUM-74). New cases only; nothing here repeats seedDemo.test.js or seedDemo.review1.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { checkPassword, hashPassword } from "./auth.js";
import { DEMO_ACCOUNTS, DEMO_EQUIPMENT, DEMO_REQUESTS, seedDemo } from "./seed-demo.js";
import { TEST_ACCOUNTS } from "./seed-dev.js";
import { addDaysISO, BORROW_MAX_DAYS, displayName, todayISO } from "../shared/rules.js";

const PASSWORD = "fixRoundOne51";
const TODAY = "2026-12-03";

async function seeded(t, today = TODAY, password = PASSWORD) {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await seedDemo(db, password, today);
  return db;
}

async function dump(db) {
  const rows = {};
  for (const [table, order] of [["users", "id"], ["sessions", "token_hash"], ["equipment", "id"], ["borrow_requests", "id"], ["notifications", "id"]]) {
    rows[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
  }
  return JSON.stringify(rows);
}

// Wraps a db so the statements of its transactions are listed in order.
function recording(db) {
  const statements = [];
  const wrapped = {
    ...db,
    transaction: (fn) => db.transaction((tx) => fn({
      ...tx,
      exec: (sql) => (statements.push(sql), tx.exec(sql)),
      prepare: (sql) => (statements.push(sql), tx.prepare(sql)),
    })),
  };
  return { wrapped, statements };
}

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
    return { status: res.status, json: text.startsWith("{") ? JSON.parse(text) : undefined, text, cookie: res.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email) => (await call("POST", "/api/auth/login", undefined, { email, password: PASSWORD })).cookie;
  return { call, login };
}

// --- Notice wording: the app itself writes the same texts the seed does ------------------------------------------------

test("the seeded notices use exactly the texts the routes write, for every kind and variant", async (t) => {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await seedDemo(db, PASSWORD); // the real Cambodia day, as the server uses
  const today = todayISO();
  const { call, login } = await serve(t, db);
  const admin = await login("chan.sokha@cadt.edu.kh");
  const rithy = await login("phan.rithy@student.cadt.edu.kh");
  const dara = await login("sok.dara@student.cadt.edu.kh");
  const idOf = async (email, item, status) =>
    (await db.prepare("SELECT r.id FROM borrow_requests r JOIN users u ON u.id = r.user_id JOIN equipment e ON e.id = r.equipment_id WHERE u.email = ? AND e.name = ? AND r.status = ?").get(email, item, status)).id;

  const seededNotices = await db.prepare("SELECT type, message FROM notifications").all();
  const maxId = (await db.prepare("SELECT MAX(id)::int AS m FROM notifications").get()).m;

  // Every kind of action the demo can show, done by the app.
  const cable = (await db.prepare("SELECT id FROM equipment WHERE name = 'HDMI Cable 3 m'").get()).id;
  const submitted = await call("POST", "/api/borrow-requests", rithy, { equipmentId: cable, borrowDate: addDaysISO(today, 1), purpose: "Wording check" });
  assert.equal(submitted.status, 201, submitted.text);
  const newId = submitted.json.request?.id ?? submitted.json.id;
  assert.equal((await call("POST", `/api/admin/borrow-requests/${newId}/approve`, admin, {})).status, 200);
  const reject = await call("POST", `/api/admin/borrow-requests/${await idOf("chea.vanna@student.cadt.edu.kh", "MacBook Air M2", "pending")}/reject`, admin, { reason: "Wording check reason" });
  assert.equal(reject.status, 200, reject.text);
  const back = await call("POST", `/api/admin/borrow-requests/${await idOf("chea.vanna@student.cadt.edu.kh", "JBL Charge 5 Speaker", "approved")}/return`, admin, {});
  assert.equal(back.status, 200, back.text);
  const adminCancel = await call("POST", `/api/admin/borrow-requests/${await idOf("ly.sreymom@student.cadt.edu.kh", "Dell Latitude 5440 Laptop", "approved")}/cancel`, admin, { reason: "Wording check reason" });
  assert.equal(adminCancel.status, 200, adminCancel.text);
  const own = await call("POST", `/api/borrow-requests/${await idOf("sok.dara@student.cadt.edu.kh", "Epson EB-X49 Projector", "pending")}/cancel`, dara, {});
  assert.equal(own.status, 200, own.text);

  // Same text up to the parts that differ per request: item, person, dates, reason.
  const names = [...DEMO_EQUIPMENT.map((e) => e.name), ...DEMO_ACCOUNTS.map((a) => displayName(a.email))];
  const shape = (message) => {
    let out = message.replace(/\d{4}-\d{2}-\d{2}/g, "<D>").replace(/Reason: .*$/, "Reason: <R>");
    for (const name of names) out = out.replaceAll(name, "<X>");
    return out;
  };
  const byType = (rows) => {
    const map = {};
    for (const { type, message } of rows) (map[type] ??= new Set()).add(shape(message));
    return map;
  };
  const appNotices = await db.prepare("SELECT type, message FROM notifications WHERE id > ?").all(maxId);
  const fromSeed = byType(seededNotices);
  const fromApp = byType(appNotices);
  assert.deepEqual(Object.keys(fromApp).sort(), Object.keys(fromSeed).sort());
  for (const type of Object.keys(fromSeed)) assert.deepEqual([...fromSeed[type]].sort(), [...fromApp[type]].sort(), type);
});

// --- Time -------------------------------------------------------------------------------------------------------------

test("whatever the hour the seed runs, every stored time is before that moment", async (t) => {
  // 00:00 in Phnom Penh to the millisecond, and one millisecond before it.
  for (const now of [new Date("2027-03-10T17:00:00.000Z"), new Date("2027-03-10T16:59:59.999Z"), new Date("2028-02-29T23:59:59.999Z")]) {
    const db = await seeded(t, todayISO(now));
    const limit = now.toISOString();
    const late = [];
    const check = (where, value) => value && value >= limit && late.push(`${where} ${value}`);
    for (const r of await db.prepare("SELECT * FROM borrow_requests").all()) for (const f of ["created_at", "decided_at", "returned_at"]) check(`request ${r.id} ${f}`, r[f]);
    for (const n of await db.prepare("SELECT * FROM notifications").all()) { check(`notice ${n.id}`, n.created_at); check(`notice ${n.id} read_at`, n.read_at); }
    for (const row of [...await db.prepare("SELECT created_at FROM users").all(), ...await db.prepare("SELECT created_at, updated_at FROM equipment").all()]) {
      for (const value of Object.values(row)) check("account or item", `${value.replace(" ", "T")}.000Z`);
    }
    assert.deepEqual(late, [], limit);
  }
});

// --- Shape of the data ------------------------------------------------------------------------------------------------

test("every state is there with the app's seven-day span, on a leap day and a month end", async (t) => {
  for (const today of ["2028-02-29", "2027-01-31", TODAY]) {
    const db = await seeded(t, today);
    const rows = await db.prepare("SELECT r.*, e.quantity, e.name FROM borrow_requests r JOIN equipment e ON e.id = r.equipment_id ORDER BY r.id").all();
    const on = (status) => rows.filter((r) => r.status === status);
    for (const r of rows) {
      assert.equal(r.return_date, addDaysISO(r.borrow_date, BORROW_MAX_DAYS), `${today} request ${r.id}`);
      assert.ok(r.quantity > 0, `${today}: nobody asks for the item with no stock (${r.name})`);
    }
    const approved = on("approved");
    assert.ok(approved.some((r) => r.return_date === addDaysISO(today, 1)), "due tomorrow");
    assert.ok(approved.some((r) => r.return_date === today), "due today");
    assert.ok(approved.filter((r) => r.return_date < today).length >= 2, "at least two overdue");
    assert.ok(approved.some((r) => r.borrow_date <= today && r.return_date > addDaysISO(today, 1)), "on loan, not due soon");
    assert.ok(approved.every((r) => r.borrow_date <= today), "every loan has started");
    assert.equal(on("returned").length, 3);
    assert.equal(on("pending").filter((r) => r.borrow_date === today).length, 1, "exactly one pending request starts today");
    assert.ok(on("pending").every((r) => r.borrow_date >= today && r.created_at.slice(0, 10) <= addDaysISO(today, -2)), "pending ones were asked at least two days ago");
    const cancelled = on("cancelled");
    assert.equal(cancelled.filter((r) => r.decided_by === null).length, 1, "cancelled by a student");
    assert.equal(cancelled.filter((r) => r.decided_by !== null && r.decision_reason).length, 1, "cancelled by an administrator");
    assert.ok(on("rejected").length >= 2 && on("rejected").every((r) => r.decision_reason && r.quantity > 0 && r.decided_by));
    const stock = await db.prepare("SELECT quantity, available FROM equipment").all();
    assert.ok(stock.some((e) => e.quantity === 0), "an item with no stock");
    assert.ok(stock.some((e) => e.quantity > 0 && e.available === 0), "an item with every copy on loan");
  }
});

test("ids follow time everywhere, and each bell keeps both new and old notices", async (t) => {
  const db = await seeded(t);
  const requests = await db.prepare("SELECT id, created_at, decided_at FROM borrow_requests ORDER BY id").all();
  for (let i = 1; i < requests.length; i++) assert.ok(requests[i].created_at >= requests[i - 1].created_at, `request ${requests[i].id} is newer than ${requests[i - 1].id}`);
  const notices = await db.prepare("SELECT id, user_id, created_at, read_at FROM notifications ORDER BY id").all();
  for (let i = 1; i < notices.length; i++) assert.ok(notices[i].created_at >= notices[i - 1].created_at, `notice ${notices[i].id}`);
  for (const { id, email } of await db.prepare("SELECT id, email FROM users").all()) {
    const mine = notices.filter((n) => n.user_id === id);
    const unread = mine.filter((n) => n.read_at === null);
    const read = mine.filter((n) => n.read_at !== null);
    assert.ok(unread.length > 0 && read.length > 0, `${email}: ${unread.length} unread, ${read.length} read`);
    assert.ok(unread.map((n) => n.created_at).sort()[0] >= read.map((n) => n.created_at).sort().at(-1), `${email}: unread notices are the newer ones`);
  }
});

test("an administrator-cancelled loan keeps its whole story, in order, and the cancel time is in decided_at", async (t) => {
  const db = await seeded(t);
  const loan = await db.prepare("SELECT r.* FROM borrow_requests r WHERE r.status = 'cancelled' AND r.decided_by IS NOT NULL").get();
  const story = await db.prepare("SELECT type, message, created_at FROM notifications WHERE request_id = ? AND user_id = ? ORDER BY id").all(loan.id, loan.user_id);
  assert.deepEqual(story.map((n) => n.type), ["request_submitted", "request_approved", "request_cancelled"]);
  assert.ok(story[0].created_at < story[1].created_at && story[1].created_at < story[2].created_at, "each step is later than the one before");
  assert.equal(story[2].created_at, loan.decided_at, "the cancel notice and decided_at are the same moment");
  assert.match(story[2].message, /^Your request for .+ was cancelled by an administrator\. Reason: .+/);
  assert.match(story[1].message, new RegExp(`on ${loan.borrow_date}; return by ${loan.return_date}\\.$`));
});

// --- Race and truncate ------------------------------------------------------------------------------------------------

test("users is locked first in the transaction, in SHARE ROW EXCLUSIVE mode, and TRUNCATE lists every table with a foreign key", async (t) => {
  const db = await seeded(t);
  const { wrapped, statements } = recording(db);
  await seedDemo(wrapped, PASSWORD, TODAY);
  assert.match(statements[0], /^\s*LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE\s*$/i, "the lock is the first statement");
  const truncate = statements.find((sql) => /^\s*TRUNCATE/i.test(sql));
  assert.ok(truncate);
  assert.ok(!/CASCADE/i.test(truncate), "nothing is emptied behind the list's back");
  const listed = new Set(/TRUNCATE\s+([\w\s,]+?)(?:\s+RESTART|\s*$)/i.exec(truncate)[1].split(",").map((x) => x.trim()));
  const fks = await db.prepare("SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent FROM pg_constraint c WHERE c.contype = 'f'").all();
  assert.ok(fks.length >= 4);
  for (const { child, parent } of fks) assert.ok(listed.has(child) && listed.has(parent), `${child} -> ${parent} is in the TRUNCATE list`);
  assert.ok(statements.findIndex((s) => /FROM users/i.test(s)) > 0, "no read of users comes before the lock");
});

// --- Password guard ---------------------------------------------------------------------------------------------------

test("a demo email whose password is not DEMO_PASSWORD blocks the reset, whatever its hash looks like, and the message names it", async (t) => {
  const db = await seeded(t);
  const target = "heng.bopha@cadt.edu.kh";
  const original = (await db.prepare("SELECT password_hash FROM users WHERE email = ?").get(target)).password_hash;
  for (const hash of [await hashPassword("SomeoneElse2026"), "x", "", "scrypt$1$1$1$zz$zz"]) {
    await db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(hash, target);
    const before = await dump(db);
    const err = await seedDemo(db, PASSWORD, TODAY).then(() => null, (e) => e);
    assert.ok(err, JSON.stringify(hash));
    assert.match(err.message, /^Refusing to load demo data: 1 account\(s\)/, err.message);
    assert.ok(err.message.includes(target) && !err.message.includes("sok.dara"), "only the blocking email is listed");
    assert.ok(!err.message.includes(PASSWORD) && !err.message.includes("SomeoneElse2026"), "no password in the message");
    assert.equal(await dump(db), before, "nothing changed");
  }
  await db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(original, target);
  await seedDemo(db, PASSWORD, TODAY); // the right password opens it again
});

test("changing DEMO_PASSWORD between runs, a stranger and a changed demo password are all listed together, and checkPassword still works as before", async (t) => {
  const db = await seeded(t);
  const err = await seedDemo(db, "AnotherDemo77", TODAY).then(() => null, (e) => e);
  assert.ok(err);
  assert.match(err.message, new RegExp(`^Refusing to load demo data: ${DEMO_ACCOUNTS.length} account\\(s\\)`));
  for (const { email } of DEMO_ACCOUNTS) assert.ok(err.message.includes(email), email);

  await db.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES ('mao.kanha@student.cadt.edu.kh', 'Mao Kanha', 'student', 'x')").run();
  await db.prepare("UPDATE users SET password_hash = ? WHERE email = 'sok.dara@student.cadt.edu.kh'").run(await hashPassword("Different2026"));
  const both = await seedDemo(db, PASSWORD, TODAY).then(() => null, (e) => e);
  assert.match(both.message, /^Refusing to load demo data: 2 account\(s\)/);
  assert.ok(both.message.includes("mao.kanha@student.cadt.edu.kh") && both.message.includes("sok.dara@student.cadt.edu.kh"));

  const hash = await hashPassword("Ünïcode pass 1");
  assert.equal(await checkPassword("Ünïcode pass 1", hash), true);
  assert.equal(await checkPassword("Ünïcode pass 2", hash), false);
});

test("seed:test accounts are cleared whatever their password is, and then the demo accounts can be loaded again", async (t) => {
  const db = await seeded(t);
  for (const [i, { email }] of TEST_ACCOUNTS.entries()) {
    await db.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES (?, 'Test', 'student', ?)").run(email, i ? "x" : await hashPassword("unrelated-pass-1"));
  }
  await seedDemo(db, PASSWORD, TODAY);
  const emails = (await db.prepare("SELECT email FROM users ORDER BY id").all()).map((u) => u.email);
  assert.deepEqual(emails, DEMO_ACCOUNTS.map((a) => a.email));
});

// --- README -----------------------------------------------------------------------------------------------------------

test("the README tells how to reach the live database, that seed:demo reads .env, and to run it on the morning of the demo", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  assert.ok(readme.includes("npm run seed:demo -- --remote"));
  assert.match(readme, /`start`, `seed:test` and `seed:demo` read a `\.env` file|`seed:demo`[^.]*read a `\.env` file/);
  assert.match(readme, /morning of the demo/);
  assert.match(readme, /another password|DEMO_PASSWORD[^.]*(opens|matches|verif)/i, "the password guard is explained");
  assert.ok(!/[–—]/.test(readme), "no em or en dashes");
});

test("the demo requests are written with no custom end date, so the app's span rule is the only source", () => {
  for (const r of DEMO_REQUESTS) assert.ok(!("to" in r), `${r.who} ${r.item}`);
});
