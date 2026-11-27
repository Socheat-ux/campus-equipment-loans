// Review round 1 of the SQLite to Postgres move (SCRUM-138). PGlite runs one transaction at a time, so these tests
// replay the interleavings real Postgres allows between separate statements by running the "other request" at a fixed
// point through a wrapped db. Titles starting with DEFECT fail until the code is fixed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { copySqliteToPostgres } from "./copy-sqlite.js";
import { addDaysISO, todayISO } from "../shared/rules.js";

const GOOD = "goodpass1";
const dir = mkdtempSync(join(tmpdir(), "pg-review1-"));
after(() => rmSync(dir, { recursive: true, force: true }));

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
  const admin = await signup("ly.sophea@cadt.edu.kh");
  await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  const item = async (name, quantity = 3) =>
    (await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Camera', ?) RETURNING id").run(name, quantity)).lastInsertRowid;
  return { db, root, call, signup, admin, item };
}

// --- Copy script --------------------------------------------------------------------------------------------------

const SQLITE_SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'faculty', 'admin')), password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL);
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

test("guard: copying into a database that already has a different user 1 hands the old user's session to that account", async (t) => {
  // Realistic order on deploy day: the server starts on Supabase, someone signs up or runs seed:test, then copy-db runs.
  const db = await openDb(":memory:");
  t.after(() => db.close());
  await db.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES ('test.admin@cadt.edu.kh', 'Test Admin', 'admin', 'x')").run();
  await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Dell Latitude 5440 Laptop', 'Laptop', 5)").run();

  const token = "old-sqlite-session";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const path = join(dir, "collide.db");
  const lite = new DatabaseSync(path);
  lite.exec(SQLITE_SCHEMA);
  lite.prepare("INSERT INTO users (id, email, full_name, role, password_hash) VALUES (1, 'sok.dara@student.cadt.edu.kh', 'Sok Dara', 'student', 'x')").run();
  lite.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, ?)").run(tokenHash, Date.now() + 3600_000);
  lite.prepare("INSERT INTO equipment (id, name, category, quantity, available, asset_id) VALUES (1, 'Epson projector', 'Projector', 1, 0, 'CG-0001')").run();
  lite.prepare("INSERT INTO borrow_requests (id, equipment_id, user_id, borrow_date, return_date, status) VALUES (1, 1, 1, '2025-03-01', '2025-03-08', 'approved')").run();
  lite.close();

  let refused = false;
  try {
    await copySqliteToPostgres(path, db);
  } catch {
    refused = true;
  }
  const owner = await db.prepare("SELECT u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?").get(tokenHash);
  if (refused) {
    assert.equal(owner, undefined, "a refused copy writes nothing");
  } else {
    // Either way, an old cookie must never sign someone in as a different (here: admin) account.
    assert.deepEqual({ ...owner }, { email: "sok.dara@student.cadt.edu.kh", role: "student" });
    const loanItem = await db.prepare("SELECT e.name FROM borrow_requests r JOIN equipment e ON e.id = r.equipment_id WHERE r.id = 1").get();
    assert.equal(loanItem.name, "Epson projector", "the old loan must stay on the old item");
  }
});

// --- Postgres text cannot hold NUL ---------------------------------------------------------------------------------

test("guard: a NUL character in a purpose, equipment name or reason answers 500 on Postgres; SQLite stored it, it must be a 4xx", async (t) => {
  const h = await start(t);
  const student = await h.signup("meas.rithy@student.cadt.edu.kh");
  const camera = await h.item("Canon EOS 250D Camera");
  const tomorrow = addDaysISO(todayISO(), 1);
  const results = {};

  results.purpose = (await h.call("POST", "/api/borrow-requests", student.cookie, { equipmentId: camera, borrowDate: tomorrow, purpose: "Club\u0000event" })).status;
  results.equipmentName = (await h.call("POST", "/api/equipment", h.admin.cookie, { name: "Tripod\u0000", category: "Camera", quantity: 1 })).status;

  const ok = await h.call("POST", "/api/borrow-requests", student.cookie, { equipmentId: camera, borrowDate: tomorrow, purpose: "ok" });
  assert.equal(ok.status, 201);
  results.rejectReason = (await h.call("POST", `/api/admin/borrow-requests/${ok.body.request.id}/reject`, h.admin.cookie, { reason: "Booked\u0000" })).status;

  const lens = await h.item("Canon zoom lens"); // a second item, so a failed reject above cannot block this request
  const again = await h.call("POST", "/api/borrow-requests", student.cookie, { equipmentId: lens, borrowDate: tomorrow, purpose: "ok" });
  assert.equal(again.status, 201);
  assert.equal((await h.call("POST", `/api/admin/borrow-requests/${again.body.request.id}/approve`, h.admin.cookie, {})).status, 200);
  results.cancelReason = (await h.call("POST", `/api/admin/borrow-requests/${again.body.request.id}/cancel`, h.admin.cookie, { reason: "Broken\u0000" })).status;

  for (const [where, status] of Object.entries(results)) assert.ok(status < 500, `${where}: ${status}`);
});

// --- Statements interleaving between requests ---------------------------------------------------------------------

test("guard: a borrow request that lands between the delete check and the DELETE turns an equipment delete into a 500", async (t) => {
  let h;
  let student;
  let camera;
  h = await start(t, (db) =>
    interleave(
      db,
      (sql) => sql.startsWith("SELECT id FROM borrow_requests WHERE equipment_id"),
      () =>
        db
          .prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date) VALUES (?, ?, ?, ?)")
          .run(camera, student.id, addDaysISO(todayISO(), 1), addDaysISO(todayISO(), 8)),
    ).wrapped,
  );
  student = await h.signup("keo.bopha@student.cadt.edu.kh");
  camera = await h.item("Sony camera");

  const res = await h.call("DELETE", `/api/equipment/${camera}`, h.admin.cookie);
  assert.equal(res.status, 409, "the item now has a request, so the delete is refused like any other");
  assert.ok(await h.db.prepare("SELECT 1 FROM equipment WHERE id = ?").get(camera), "the item stays");
});

test("guard: an item deleted between the equipment lookup and the insert turns a borrow request into a 500 instead of 404", async (t) => {
  let camera;
  const h = await start(t, (db) =>
    interleave(
      db,
      (sql) => sql.startsWith("SELECT id, name, available FROM equipment"),
      () => db.prepare("DELETE FROM equipment WHERE id = ?").run(camera),
    ).wrapped,
  );
  const student = await h.signup("chea.dara@student.cadt.edu.kh");
  camera = await h.item("Rode microphone");

  const res = await h.call("POST", "/api/borrow-requests", student.cookie, { equipmentId: camera, borrowDate: addDaysISO(todayISO(), 1) });
  assert.equal(res.status, 404);
  assert.equal((await h.db.prepare("SELECT COUNT(*)::int AS n FROM notifications").get()).n, 0, "no notices for a request that was never made");
});

test("guard: a loan returned between the reminder scan and its transaction still gets a 'return by tomorrow' reminder", async (t) => {
  let loanId;
  const h = await start(t, (db) =>
    interleave(
      db,
      (sql) => sql.includes("n.type = 'due_soon'") && sql.includes("NOT EXISTS"),
      () => db.prepare("UPDATE borrow_requests SET status = 'returned', returned_at = ? WHERE id = ?").run(new Date().toISOString(), loanId),
    ).wrapped,
  );
  const student = await h.signup("pich.sreyleak@student.cadt.edu.kh");
  const kit = await h.item("Arduino kit");
  const today = todayISO();
  loanId = (
    await h.db
      .prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, status) VALUES (?, ?, ?, ?, 'approved') RETURNING id")
      .run(kit, student.id, addDaysISO(today, -6), addDaysISO(today, 1))
  ).lastInsertRowid;

  const bell = await h.call("GET", "/api/notifications", student.cookie);
  assert.equal(bell.status, 200);
  const reminders = await h.db.prepare("SELECT id FROM notifications WHERE request_id = ? AND type = 'due_soon'").all(loanId);
  assert.equal(reminders.length, 0, "the item is back, so no reminder");
});

// --- Guards: Postgres specifics the old tests never had to cover ----------------------------------------------------

test("guard: stored times stay UTC with a Z even when the database session runs in Phnom Penh time", async (t) => {
  const h = await start(t);
  await h.db.exec("SET TimeZone = 'Asia/Phnom_Penh'");
  const student = await h.signup("sok.dara@student.cadt.edu.kh");
  const camera = await h.item("Canon camera");
  const made = await h.call("POST", "/api/borrow-requests", student.cookie, { equipmentId: camera, borrowDate: addDaysISO(todayISO(), 1) });
  assert.equal(made.status, 201);
  const near = (iso, label) => assert.ok(Math.abs(Date.parse(iso) - Date.now()) < 5 * 60_000, `${label} ${iso} is not now in UTC`);

  assert.match(made.body.request.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  near(made.body.request.createdAt, "request createdAt");
  const bell = await h.call("GET", "/api/notifications", student.cookie);
  near(bell.body.notifications[0].createdAt, "notification createdAt");
  const users = await h.call("GET", "/api/users", h.admin.cookie);
  const created = users.body.users.find((u) => u.id === student.id).createdAt;
  assert.match(created, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, "users keep the SQLite CURRENT_TIMESTAMP shape");
  near(`${created.replace(" ", "T")}Z`, "user createdAt");
});

test("guard: a ? or a backslash in user text is data, never a placeholder or a LIKE escape", async (t) => {
  const h = await start(t);
  const student = await h.signup("lim.vanna@student.cadt.edu.kh");
  const made = await h.call("POST", "/api/equipment", h.admin.cookie, { name: "Which cable? C:\\temp kit", category: "Accessories", quantity: 2 });
  assert.equal(made.status, 201);
  assert.equal(made.body.equipment.name, "Which cable? C:\\temp kit");
  const plain = await h.item("Plain tripod");
  for (const equipmentId of [made.body.equipment.id, plain]) {
    const res = await h.call("POST", "/api/borrow-requests", student.cookie, { equipmentId, borrowDate: addDaysISO(todayISO(), 1), purpose: "Why? Because \\ $1 ?" });
    assert.equal(res.status, 201);
    assert.equal(res.body.request.purpose, "Why? Because \\ $1 ?");
  }
  const names = async (q) =>
    (await h.call("GET", `/api/admin/borrow-requests?status=all&item=${encodeURIComponent(q)}`, h.admin.cookie)).body.requests.map((r) => r.equipmentName);
  assert.deepEqual(await names("?"), ["Which cable? C:\\temp kit"]);
  assert.deepEqual(await names("\\"), ["Which cable? C:\\temp kit"]);
  assert.deepEqual(await names("\\t"), ["Which cable? C:\\temp kit"], "a backslash does not escape the next letter");
  assert.deepEqual(await names("\\%"), [], "a backslash does not turn % into a literal");
  assert.deepEqual(await names("WHICH CABLE?"), ["Which cable? C:\\temp kit"], "case is ignored");
});
