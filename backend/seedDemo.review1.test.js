// Review round 1 of the demo seed (SCRUM-74). New cases only; nothing here repeats seedDemo.test.js.
// Titles that started with DEFECT failed until fix round 1; they are guards now. The signup race needs two real Postgres connections, so it
// was shown on a throwaway local Postgres 18 outside this file; the last test pins the fix on PGlite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { backfillAdminRequestNotifications, MESSAGE_MAX, NOTIFICATION_TYPES, processDueReminders } from "./notifications.js";
import { DEMO_ACCOUNTS, DEMO_REQUESTS, seedDemo } from "./seed-demo.js";
import { seedTestAccounts, TEST_ACCOUNTS } from "./seed-dev.js";
import {
  addDaysISO, BORROW_MAX_DAYS, equipmentCategoryError, equipmentNameError, equipmentQuantityError, purposeError,
  rejectionReasonError, todayISO,
} from "../shared/rules.js";

const script = fileURLToPath(new URL("./seed-demo.js", import.meta.url));
const PASSWORD = "reviewDemo42";
const TODAY = "2026-12-03";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const phnomPenhDay = (iso) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Phnom_Penh" });

async function seeded(t, today = TODAY) {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await seedDemo(db, PASSWORD, today);
  return db;
}

async function dump(db) {
  const rows = {};
  for (const [table, order] of [["users", "id"], ["sessions", "token_hash"], ["equipment", "id"], ["borrow_requests", "id"], ["notifications", "id"]]) {
    rows[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
  }
  return JSON.stringify(rows);
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
    let json;
    try {
      json = JSON.parse(text);
    } catch {} // the CSV
    return { status: res.status, json, text, cookie: res.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (email, password = PASSWORD) => (await call("POST", "/api/auth/login", undefined, { email, password })).cookie;
  return { call, login };
}

const onShelfMatchesLoans = async (db) =>
  db.prepare(
    `SELECT e.name, e.quantity, e.available, (SELECT COUNT(*)::int FROM borrow_requests r WHERE r.equipment_id = e.id AND r.status = 'approved') AS out
     FROM equipment e WHERE e.available <> e.quantity - (SELECT COUNT(*) FROM borrow_requests r WHERE r.equipment_id = e.id AND r.status = 'approved')`,
  ).all();

// --- 1. The data survives every admin action the demo can show ---------------------------------------------------------

test("guard: on the seed day the app accepts every action on the seeded rows and stock stays equal to the loans", async (t) => {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await seedDemo(db, PASSWORD); // the real Cambodia day, as the server uses
  const today = todayISO();
  const { call, login } = await serve(t, db);
  const admin = await login("chan.sokha@cadt.edu.kh");
  const student = await login("sok.dara@student.cadt.edu.kh");
  assert.ok(admin && student, "demo logins work");

  // The app sees the seeded pending request as the one-pending-per-item duplicate.
  const projector = await db.prepare("SELECT id FROM equipment WHERE name = 'Epson EB-X49 Projector'").get();
  const dup = await call("POST", "/api/borrow-requests", student, { equipmentId: projector.id, borrowDate: today });
  assert.equal(dup.status, 409, dup.text);
  const seededPending = await db.prepare(
    "SELECT r.id FROM borrow_requests r JOIN users u ON u.id = r.user_id WHERE u.email = 'sok.dara@student.cadt.edu.kh' AND r.status = 'pending' AND r.equipment_id = ?",
  ).get(projector.id);
  assert.equal(dup.json.existingRequestId, seededPending.id);

  // No pending row shows "Start date passed" on the seed day, and every one can be approved by a demo admin.
  const pending = (await call("GET", "/api/admin/borrow-requests?status=pending", admin)).json;
  assert.equal(pending.today, today);
  assert.ok(pending.requests.length >= 3);
  for (const r of pending.requests) {
    assert.ok(r.borrowDate >= today, `request ${r.id} is not stale`);
    assert.notEqual(r.requesterRole, "admin");
    const res = await call("POST", `/api/admin/borrow-requests/${r.id}/approve`, admin, {});
    assert.equal(res.status, 200, `approve ${r.id}: ${res.text}`);
    assert.equal(res.json.request.returnDate, addDaysISO(r.borrowDate, BORROW_MAX_DAYS));
  }

  // Overdue loans can be marked returned; the due-today loan can be cancelled by an admin.
  const overdue = (await call("GET", "/api/admin/overdue", admin)).json.overdue;
  assert.ok(overdue.length >= 2);
  for (const loan of overdue) {
    const res = await call("POST", `/api/admin/borrow-requests/${loan.id}/return`, admin, {});
    assert.equal(res.status, 200, `return ${loan.id}: ${res.text}`);
  }
  const dueToday = await db.prepare("SELECT id FROM borrow_requests WHERE status = 'approved' AND return_date = ?").get(today);
  assert.ok(dueToday, "a loan due today");
  const cancel = await call("POST", `/api/admin/borrow-requests/${dueToday.id}/cancel`, admin, { reason: "Lab closed for the demo." });
  assert.equal(cancel.status, 200, cancel.text);

  assert.deepEqual(await onShelfMatchesLoans(db), [], "available = quantity - approved loans for every item");
  assert.equal((await call("GET", "/api/admin/overdue", admin)).json.overdue.length, 0);
  const csv = await call("GET", "/api/admin/borrow-requests/export.csv?status=returned", admin);
  assert.equal(csv.status, 200);
  assert.equal(csv.text.trim().split("\r\n").length, 1 + DEMO_REQUESTS.filter((r) => r.status === "returned").length + overdue.length);
  for (const { email } of DEMO_ACCOUNTS) {
    const bell = await call("GET", "/api/notifications", await login(email));
    assert.equal(bell.status, 200, `${email} bell`);
  }
});

test("guard: a rehearsal signup blocks the reset without touching sessions; after removing it the reset logs everyone out", async (t) => {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await seedDemo(db, PASSWORD);
  const { call, login } = await serve(t, db);
  const admin = await login("pich.sopheap@cadt.edu.kh");
  const signup = await call("POST", "/api/auth/signup", undefined, { email: "Mao.Kanha@Student.CADT.edu.kh", password: "Rehearse2026" });
  assert.equal(signup.status, 201, signup.text);

  const before = await dump(db);
  await assert.rejects(seedDemo(db, PASSWORD), /1 account\(s\)/);
  assert.equal(await dump(db), before, "a refused reset changes nothing, sessions included");
  assert.equal((await call("GET", "/api/auth/me", admin)).status, 200);

  await db.prepare("DELETE FROM users WHERE email = 'mao.kanha@student.cadt.edu.kh'").run();
  await seedDemo(db, PASSWORD);
  assert.equal((await call("GET", "/api/auth/me", admin)).status, 401, "an old cookie dies with the reset");
  assert.equal((await call("GET", "/api/auth/me", signup.cookie)).status, 401);
  const again = await login("pich.sopheap@cadt.edu.kh");
  assert.ok(again);
  assert.equal((await call("GET", "/api/admin/borrow-requests", again)).json.counts.pending, DEMO_REQUESTS.filter((r) => r.status === "pending").length);
});

// --- 2. The guard -----------------------------------------------------------------------------------------------------

test("guard: accounts that only look like demo ones (other case, other domain, trailing space) block the reset", async (t) => {
  const db = await seeded(t);
  for (const email of ["Sok.Dara@student.cadt.edu.kh", "sok.dara@cadt.edu.kh", "chan.sokha@cadt.edu.kh ", "test.admin@student.cadt.edu.kh"]) {
    const { lastInsertRowid: id } = await db.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES (?, 'X', 'student', 'x') RETURNING id").run(email);
    const before = await dump(db);
    await assert.rejects(seedDemo(db, PASSWORD, TODAY), /Refusing/, JSON.stringify(email));
    assert.equal(await dump(db), before, JSON.stringify(email));
    await db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }
});

test("guard: a database made by seed:test is cleared completely, its sample loan and notices included", async (t) => {
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await seedTestAccounts(db);
  assert.ok((await db.prepare("SELECT COUNT(*)::int AS n FROM borrow_requests").get()).n > 0);
  await seedDemo(db, PASSWORD, TODAY);
  const emails = (await db.prepare("SELECT email FROM users ORDER BY id").all()).map((u) => u.email);
  assert.deepEqual(emails, DEMO_ACCOUNTS.map((a) => a.email));
  for (const { email } of TEST_ACCOUNTS) assert.ok(!emails.includes(email));
  assert.equal((await db.prepare("SELECT COUNT(*)::int AS n FROM borrow_requests WHERE purpose LIKE 'DEMO:%'").get()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*)::int AS n FROM equipment").get()).n, 10, "no sample item is left beside the demo ones");
});

test("guard: a run that fails after emptying the tables puts back every row and the id counters", async (t) => {
  const db = await seeded(t);
  await db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('h1', 1, ?)").run(Date.now() + 1e6);
  // Fails near the end, long after TRUNCATE ... RESTART IDENTITY ran inside the transaction.
  await db.exec(`CREATE FUNCTION boom() RETURNS trigger AS $$ BEGIN IF NEW.message LIKE '%HDMI%' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER boom BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION boom();`);
  const before = await dump(db);
  await assert.rejects(seedDemo(db, PASSWORD, addDaysISO(TODAY, 1)), /boom/);
  assert.equal(await dump(db), before);
  const next = await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Probe', 'Other', 1) RETURNING id").run();
  assert.equal(next.lastInsertRowid, 11, "the identity restart was rolled back too");
});

test("guard: the command with --remote and an unreachable or non-postgres URL fails with exit 1 and prints neither password", async () => {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve)); // free again, so nothing answers there
  const env = { ...process.env, DEMO_PASSWORD: PASSWORD };
  delete env.NODE_ENV;
  delete env.PGDATA_DIR;
  for (const [url, message] of [
    [`postgres://nobody:url-secret-77@127.0.0.1:${port}/nodb`, /ECONNREFUSED|connect/i],
    [`mysql://nobody:url-secret-77@127.0.0.1:${port}/nodb`, /not a postgres/],
  ]) {
    const run = spawnSync(process.execPath, [script, "--remote"], { env: { ...env, DATABASE_URL: url }, encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, message);
    const out = run.stdout + run.stderr;
    assert.ok(!out.includes("url-secret-77") && !out.includes(PASSWORD), "no secret printed");
    assert.ok(!/Demo data in/.test(run.stdout));
  }
});

// --- 3. The rows obey the app's own formats and limits ------------------------------------------------------------------

test("guard: every stored time has the app's format, Phnom Penh and UTC agree on each day, and events happen in order", async (t) => {
  for (const today of [TODAY, "2027-01-01", "2028-02-29"]) {
    const db = await seeded(t, today);
    for (const u of await db.prepare("SELECT created_at FROM users").all()) {
      assert.match(u.created_at, SQL_TIME);
      // The users page shows createdAt.slice(0, 10) of a UTC time.
      assert.equal(phnomPenhDay(`${u.created_at.replace(" ", "T")}Z`), u.created_at.slice(0, 10));
    }
    for (const e of await db.prepare("SELECT created_at, updated_at FROM equipment").all()) {
      assert.match(e.created_at, SQL_TIME);
      assert.match(e.updated_at, SQL_TIME);
    }
    for (const r of await db.prepare("SELECT * FROM borrow_requests").all()) {
      const where = `${today} request ${r.id}`;
      assert.match(r.created_at, ISO, where);
      for (const field of ["decided_at", "returned_at"]) if (r[field] !== null) assert.match(r[field], ISO, `${where} ${field}`);
      if (r.decided_at) assert.ok(r.decided_at > r.created_at, `${where} decided after it was asked`);
      if (r.returned_at) {
        assert.ok(r.returned_at > r.decided_at, `${where} returned after approval`);
        // My requests shows returnedAt.slice(0, 10); the CSV shows the Phnom Penh time. Both must name the same day.
        assert.equal(r.returned_at.slice(0, 10), phnomPenhDay(r.returned_at), where);
        assert.ok(r.returned_at.slice(0, 10) >= r.borrow_date && r.returned_at.slice(0, 10) <= r.return_date, `${where} returned within the loan`);
      }
    }
    for (const n of await db.prepare("SELECT * FROM notifications").all()) {
      assert.match(n.created_at, ISO);
      if (n.read_at !== null) {
        assert.match(n.read_at, ISO);
        assert.ok(n.read_at >= n.created_at);
      }
    }
  }
});

test("guard: every seeded text passes the validator the app applies to the same field", async (t) => {
  const db = await seeded(t);
  for (const e of await db.prepare("SELECT * FROM equipment").all()) {
    assert.equal(equipmentNameError(e.name), null, e.name);
    assert.equal(equipmentCategoryError(e.category), null, e.name);
    assert.equal(equipmentQuantityError(e.quantity), null, e.name);
  }
  for (const r of await db.prepare("SELECT * FROM borrow_requests").all()) {
    assert.equal(purposeError(r.purpose), null, `request ${r.id}`);
    if (r.status === "rejected") assert.equal(rejectionReasonError(r.decision_reason), null, `request ${r.id}`);
    if (r.status === "cancelled" && r.decision_reason) assert.ok(r.decision_reason.length <= 300, "admin cancel reasons stop at 300");
    if (!["rejected", "cancelled"].includes(r.status)) assert.equal(r.decision_reason, null, `request ${r.id} has no reason`);
  }
  for (const n of await db.prepare("SELECT * FROM notifications").all()) {
    assert.ok(NOTIFICATION_TYPES.includes(n.type), n.type);
    assert.ok(n.message.length > 0 && n.message.length <= MESSAGE_MAX);
    assert.ok(n.title, "notify() set a title");
    assert.equal(Boolean(n.reason), n.type === "request_rejected", `notification ${n.id} reason`);
  }
});

test("guard: the first bell load after seeding backfills nothing, and a repeated reminder poll adds nothing", async (t) => {
  const db = await seeded(t);
  const count = async () => (await db.prepare("SELECT COUNT(*)::int AS n FROM notifications").get()).n;
  for (const admin of await db.prepare("SELECT id FROM users WHERE role = 'admin'").all()) {
    assert.equal(await backfillAdminRequestNotifications(db, admin.id), 0, `admin ${admin.id} already has a notice per request`);
  }
  for (let day = 0; day <= BORROW_MAX_DAYS; day++) {
    const date = addDaysISO(TODAY, day);
    await processDueReminders(db, date);
    const settled = await count();
    assert.equal(await processDueReminders(db, date), 0, date);
    assert.equal(await count(), settled);
  }
  const reminders = await db.prepare(
    "SELECT u.role, r.status FROM notifications n JOIN borrow_requests r ON r.id = n.request_id JOIN users u ON u.id = n.user_id WHERE n.type = 'due_soon'",
  ).all();
  assert.ok(reminders.every((x) => x.role !== "admin" && x.status === "approved"), "reminders only go to borrowers of loans still out");
});

// --- 4. Defects -------------------------------------------------------------------------------------------------------

test("guard: nothing is dated after the start of the Cambodia day the seed runs, so no time is in the future at any hour", async (t) => {
  const db = await seeded(t);
  const dayStart = `${addDaysISO(TODAY, -1)}T17:00:00.000Z`; // 00:00 in Phnom Penh
  const late = [];
  for (const r of await db.prepare("SELECT * FROM borrow_requests").all()) {
    for (const field of ["created_at", "decided_at", "returned_at"]) if (r[field] && r[field] > dayStart) late.push(`request ${r.id} ${field} ${r[field]}`);
  }
  for (const n of await db.prepare("SELECT * FROM notifications").all()) {
    if (n.created_at > dayStart) late.push(`notification ${n.id} (${n.type}, request ${n.request_id}) ${n.created_at}`);
  }
  assert.deepEqual(late, []);
});

test("guard: each bell lists its notices newest first, as ids follow time in the app", async (t) => {
  const db = await seeded(t);
  const wrong = [];
  for (const { id, email } of await db.prepare("SELECT id, email FROM users").all()) {
    // The bell's own query: ORDER BY id DESC.
    const rows = await db.prepare("SELECT id, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC").all(id);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].created_at > rows[i - 1].created_at) wrong.push(`${email}: #${rows[i].id} ${rows[i].created_at} under #${rows[i - 1].id} ${rows[i - 1].created_at}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("guard: every return date is seven days after the borrow date, the only span the app ever stores", async (t) => {
  const db = await seeded(t);
  const rows = await db.prepare("SELECT id, status, borrow_date, return_date FROM borrow_requests").all();
  const off = rows.filter((r) => r.return_date !== addDaysISO(r.borrow_date, BORROW_MAX_DAYS)).map((r) => `${r.id} ${r.status} ${r.borrow_date}..${r.return_date}`);
  assert.deepEqual(off, []);
});

test("guard: every borrower has the 'submitted' notice the app writes for their own request", async (t) => {
  const db = await seeded(t);
  const missing = await db.prepare(
    `SELECT r.id FROM borrow_requests r WHERE NOT EXISTS (
       SELECT 1 FROM notifications n WHERE n.user_id = r.user_id AND n.request_id = r.id AND n.type = 'request_submitted')
     ORDER BY r.id`,
  ).all();
  assert.deepEqual(missing.map((r) => r.id), []);
});

test("guard: the account check runs after users is locked against inserts, so a signup cannot slip in before TRUNCATE", async (t) => {
  // Shown on real Postgres: a signup that commits between the COUNT and the TRUNCATE is deleted. PGlite has one
  // connection, so this records the statements instead and asks for a lock that blocks INSERT before the check.
  const db = await seeded(t);
  const statements = [];
  const recording = {
    ...db,
    transaction: (fn) => db.transaction((tx) => fn({
      ...tx,
      exec: (sql) => (statements.push(sql), tx.exec(sql)),
      prepare: (sql) => (statements.push(sql), tx.prepare(sql)),
    })),
  };
  await seedDemo(recording, PASSWORD, TODAY);
  const check = statements.findIndex((sql) => /FROM users WHERE NOT/i.test(sql));
  assert.ok(check >= 0, "the account check ran");
  const blocksInsert = (sql) => {
    const m = /^\s*LOCK\s+(?:TABLE\s+)?(?:ONLY\s+)?([^;]*?)(?:\s+IN\s+([A-Z ]+?)\s+MODE)?\s*(?:NOWAIT)?\s*;?\s*$/i.exec(sql);
    if (!m || !/\busers\b/i.test(m[1])) return false;
    const mode = (m[2] ?? "ACCESS EXCLUSIVE").toUpperCase().replace(/\s+/g, " ");
    return ["SHARE", "SHARE ROW EXCLUSIVE", "EXCLUSIVE", "ACCESS EXCLUSIVE"].includes(mode);
  };
  const before = statements.slice(0, check).flatMap((sql) => sql.split(";"));
  assert.ok(before.some(blocksInsert), `no blocking LOCK on users before: ${statements[check].trim()}`);
});
