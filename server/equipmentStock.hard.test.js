import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { addDaysISO, todayISO } from "./rules.js";
import { asCard } from "../src/equipment/cards.js";

const GOOD = "goodpass1";

async function start(t) {
  const db = openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, cookie, body) => {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json() };
  };
  let people = 0;
  const signup = async (email) => {
    const res = await fetch(`${root}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: GOOD }),
    });
    assert.equal(res.status, 201);
    return { id: (await res.json()).user.id, cookie: res.headers.get("set-cookie").split(";")[0] };
  };
  const { id: adminId, cookie: admin } = await signup("chan.nita@cadt.edu.kh");
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminId);

  const item = async (quantity) =>
    (await call("POST", "/api/equipment", admin, { name: "Canon camera", category: "Camera", quantity })).body.equipment.id;
  const edit = (id, quantity) => call("PUT", `/api/equipment/${id}`, admin, { name: "Canon camera", category: "Camera", quantity });
  // A pending request from a new student each time.
  const ask = async (equipmentId) => {
    people += 1;
    const email = `keo.bopha${people}@student.cadt.edu.kh`;
    const res = await call("POST", "/api/borrow-requests", (await signup(email)).cookie, {
      equipmentId,
      borrowDate: addDaysISO(todayISO(), 2),
      purpose: "Media club shoot",
    });
    assert.equal(res.status, 201);
    return res.body.request.id;
  };
  const approve = (id) => call("POST", `/api/admin/borrow-requests/${id}/approve`, admin);
  const giveBack = (id) => call("POST", `/api/admin/borrow-requests/${id}/return`, admin);
  const row = (id) => db.prepare("SELECT quantity, available FROM equipment WHERE id = ?").get(id);
  const approvedCount = (id) =>
    db.prepare("SELECT COUNT(*) AS n FROM borrow_requests WHERE equipment_id = ? AND status = 'approved'").get(id).n;
  return { db, item, edit, ask, approve, giveBack, row, approvedCount };
}

test("eight parallel approvals on two copies approve exactly two and leave none available", async (t) => {
  const h = await start(t);
  const id = await h.item(2);
  const requests = [];
  for (let i = 0; i < 8; i += 1) requests.push(await h.ask(id));

  const results = await Promise.all(requests.map(h.approve));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 409, 409, 409, 409, 409, 409]);
  assert.deepEqual({ ...h.row(id) }, { quantity: 2, available: 0 });
  assert.equal(h.approvedCount(id), 2);
});

test("approvals racing an edit that lowers the total never break the stock rules", async (t) => {
  const h = await start(t);
  const id = await h.item(3);
  const requests = [];
  for (let i = 0; i < 3; i += 1) requests.push(await h.ask(id));

  const [lowered, ...approvals] = await Promise.all([h.edit(id, 1), ...requests.map(h.approve)]);
  const { quantity, available } = h.row(id);
  const onLoan = h.approvedCount(id);
  assert.ok([200, 400].includes(lowered.status));
  assert.equal(approvals.filter((r) => r.status === 200).length, onLoan);
  assert.ok(available >= 0 && available <= quantity);
  assert.equal(quantity - available, onLoan);
});

test("several edits while two copies are out, then both returns, end with every owned copy available", async (t) => {
  const h = await start(t);
  const id = await h.item(2);
  const loans = [await h.ask(id), await h.ask(id)];
  for (const loan of loans) assert.equal((await h.approve(loan)).status, 200);

  for (const [total, shelf] of [[5, 3], [2, 0], [3, 1]]) {
    assert.equal((await h.edit(id, total)).status, 200);
    assert.deepEqual({ ...h.row(id) }, { quantity: total, available: shelf });
  }
  assert.equal((await h.edit(id, 0)).status, 400);
  for (const loan of loans) assert.equal((await h.giveBack(loan)).status, 200);
  assert.deepEqual({ ...h.row(id) }, { quantity: 3, available: 3 });
});

test("a pending request cannot be approved after the total is edited down to 0", async (t) => {
  const h = await start(t);
  const id = await h.item(1);
  const request = await h.ask(id);
  assert.equal((await h.edit(id, 0)).status, 200);

  const refused = await h.approve(request);
  assert.equal(refused.status, 409);
  assert.deepEqual({ ...h.row(id) }, { quantity: 0, available: 0 });
});

test("catalogue cards carry the shelf count and the total separately", () => {
  const card = asCard({ id: 7, name: "Tripod", category: "Camera", quantity: 3, available: 1 });
  assert.equal(card.stock, 1);
  assert.equal(card.total, 3);
  assert.equal(card.available, true);
  assert.equal(asCard({ id: 8, name: "Mic", category: "Audio", quantity: 2, available: 0 }).available, false);
});

// The oldest shape this app ever wrote: no asset_id, location or available columns, no 'cancelled' status, no decision columns.
function oldDatabase(path) {
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('student', 'faculty', 'admin')), password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE equipment (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE borrow_requests (id INTEGER PRIMARY KEY,
      equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE RESTRICT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      borrow_date TEXT NOT NULL, return_date TEXT NOT NULL, purpose TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE notifications (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL, message TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO users (id, email, full_name, role, password_hash) VALUES
      (1, 'sok.dara@student.cadt.edu.kh', 'Sok Dara', 'student', 'x'),
      (2, 'chan.nita@cadt.edu.kh', 'Chan Nita', 'admin', 'x');
    -- quantity was the shelf count: the laptop shows 1 left while 2 are out.
    INSERT INTO equipment (id, name, category, quantity) VALUES
      (1, 'Dell laptop', 'Laptop', 1), (2, 'Epson projector', 'Projector', 0), (3, 'Arduino kit', 'Lab', 4);
    INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, status) VALUES
      (1, 1, '2026-11-01', '2026-11-08', 'approved'),
      (1, 1, '2026-11-02', '2026-11-09', 'approved'),
      (1, 1, '2026-10-01', '2026-10-08', 'returned'),
      (1, 1, '2026-11-20', '2026-11-27', 'pending'),
      (1, 1, '2026-11-20', '2026-11-27', 'rejected'),
      (2, 1, '2026-11-03', '2026-11-10', 'approved');
  `);
  old.close();
}

test("the migration on an old-shaped database adds loans back to the total and a second run changes nothing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scrum41-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "app.db");
  oldDatabase(path);

  const expected = [
    { id: 1, quantity: 3, available: 1 },
    { id: 2, quantity: 1, available: 0 },
    { id: 3, quantity: 4, available: 4 },
  ];
  const read = (db) => db.prepare("SELECT id, quantity, available FROM equipment ORDER BY id").all().map((r) => ({ ...r }));
  for (let run = 0; run < 2; run += 1) {
    const db = openDb(path);
    try {
      assert.deepEqual(read(db), expected, `run ${run + 1}`);
    } finally {
      db.close();
    }
  }

  // New rows after the migration get a full shelf, and the CHECK now guards the columns.
  const db = openDb(path);
  try {
    db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Tripod', 'Camera', 2)").run();
    assert.deepEqual({ ...db.prepare("SELECT quantity, available FROM equipment WHERE name = 'Tripod'").get() }, { quantity: 2, available: 2 });
    assert.throws(() => db.prepare("UPDATE equipment SET available = 4 WHERE id = 1").run(), /CHECK constraint failed/);
    assert.throws(() => db.prepare("UPDATE equipment SET available = -1 WHERE id = 3").run(), /CHECK constraint failed/);
  } finally {
    db.close(); // Windows cannot delete the folder while the file is open.
  }
});
