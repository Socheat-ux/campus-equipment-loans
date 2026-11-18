import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { addDaysISO, todayISO } from "./rules.js";

const GOOD = "goodpass1";

async function start(t) {
  const db = openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, cookie) =>
    fetch(`${root}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const signup = async (email, role = "student") => {
    const res = await call("POST", "/api/auth/signup", { email, password: GOOD });
    assert.equal(res.status, 201);
    const { user } = await res.json();
    if (role === "admin") db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    return { cookie: res.headers.get("set-cookie").split(";")[0], id: user.id };
  };
  const addEquipment = (name, quantity) =>
    Number(
      db
        .prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Laptop', ?)")
        .run(name, quantity).lastInsertRowid,
    );
  const createRequest = async (student, equipmentId, name = "Dell Latitude", purpose = "Final year project") => {
    const borrowDate = addDaysISO(todayISO(), 1);
    const res = await call(
      "POST",
      "/api/borrow-requests",
      { equipmentId, borrowDate, purpose },
      student.cookie,
    );
    assert.equal(res.status, 201);
    return { ...(await res.json()).request, borrowDate, name };
  };
  return { db, call, signup, addEquipment, createRequest };
}

test("an admin sees pending requests with requester, item and stock details plus counts", async (t) => {
  const { db, call, signup, addEquipment, createRequest } = await start(t);
  const admin = await signup("chan.nita@cadt.edu.kh", "admin");
  const student = await signup("sok.dara@student.cadt.edu.kh");
  await db.prepare("UPDATE users SET full_name = 'Sok Dara' WHERE id = ?").run(student.id);
  const equipmentId = addEquipment("Dell Latitude", 3);
  const request = await createRequest(student, equipmentId);

  const columns = db.prepare("PRAGMA table_info(borrow_requests)").all().map((col) => col.name);
  for (const name of ["decided_by", "decided_at", "decision_reason"]) assert.ok(columns.includes(name), name);

  const res = await call("GET", "/api/admin/borrow-requests", undefined, admin.cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const data = await res.json();
  assert.deepEqual(data.counts, { pending: 1, approved: 0, rejected: 0, cancelled: 0 });
  assert.equal(data.requests.length, 1);
  assert.deepEqual(data.requests[0], {
    id: request.id,
    equipmentId,
    equipmentName: "Dell Latitude",
    equipmentAssetId: `CG-${String(equipmentId).padStart(4, "0")}`,
    equipmentLocation: "Main store",
    stock: 3,
    userId: student.id,
    requesterName: "Sok Dara",
    requesterRole: "student",
    borrowDate: request.borrowDate,
    returnDate: request.returnDate,
    purpose: "Final year project",
    status: "pending",
    createdAt: request.createdAt,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    returnedAt: null,
  });

  for (const status of ["approved", "rejected"]) {
    const filtered = await call("GET", `/api/admin/borrow-requests?status=${status}`, undefined, admin.cookie);
    assert.deepEqual((await filtered.json()).requests, []);
  }
  const bad = await call("GET", "/api/admin/borrow-requests?status=done", undefined, admin.cookie);
  assert.equal(bad.status, 400);
});

test("approval records the decision, reserves one item and notifies the student", async (t) => {
  const { db, call, signup, addEquipment, createRequest } = await start(t);
  const admin = await signup("chan.nita@cadt.edu.kh", "admin");
  const student = await signup("sok.dara@student.cadt.edu.kh");
  const equipmentId = addEquipment("Dell Latitude", 2);
  const request = await createRequest(student, equipmentId);

  const res = await call("POST", `/api/admin/borrow-requests/${request.id}/approve`, {}, admin.cookie);
  assert.equal(res.status, 200);
  const { request: decided } = await res.json();
  assert.equal(decided.status, "approved");
  assert.equal(decided.decidedBy, admin.id);
  assert.match(decided.decidedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(decided.decisionReason, null);
  assert.equal(decided.returnDate, request.returnDate);
  assert.equal(decided.returnedAt, null);
  assert.equal(decided.stock, 1);
  assert.equal(db.prepare("SELECT quantity FROM equipment WHERE id = ?").get(equipmentId).quantity, 1);

  const notice = db
    .prepare("SELECT type, message, reason FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1")
    .get(student.id);
  assert.equal(notice.type, "request_approved");
  assert.equal(
    notice.message,
    `Request approved. Dell Latitude is ready for pickup at Main store on ${request.borrowDate}; return by ${request.returnDate}.`,
  );
  assert.equal(notice.reason, null);

  const again = await call("POST", `/api/admin/borrow-requests/${request.id}/approve`, {}, admin.cookie);
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: "Only pending requests can be approved." });
  const pending = await call("GET", "/api/admin/borrow-requests", undefined, admin.cookie);
  assert.deepEqual((await pending.json()).requests, []);
});

test("approval refuses a request when the item has no stock left", async (t) => {
  const { db, call, signup, addEquipment, createRequest } = await start(t);
  const admin = await signup("chan.nita@cadt.edu.kh", "admin");
  const student = await signup("sok.dara@student.cadt.edu.kh");
  const equipmentId = addEquipment("Checked out camera", 1);
  const request = await createRequest(student, equipmentId, "Checked out camera");
  db.prepare("UPDATE equipment SET quantity = 0 WHERE id = ?").run(equipmentId);

  const res = await call("POST", `/api/admin/borrow-requests/${request.id}/approve`, {}, admin.cookie);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "This item is no longer available." });
  assert.equal(db.prepare("SELECT status FROM borrow_requests WHERE id = ?").get(request.id).status, "pending");
  assert.equal(db.prepare("SELECT quantity FROM equipment WHERE id = ?").get(equipmentId).quantity, 0);
  const notices = db.prepare("SELECT type FROM notifications WHERE user_id = ?").all(student.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "request_submitted");
});

test("rejection saves the reason, leaves stock alone and notifies the student", async (t) => {
  const { db, call, signup, addEquipment, createRequest } = await start(t);
  const admin = await signup("chan.nita@cadt.edu.kh", "admin");
  const student = await signup("sok.dara@student.cadt.edu.kh");
  const equipmentId = addEquipment("Dell Latitude", 2);
  const request = await createRequest(student, equipmentId);

  const res = await call("POST", `/api/admin/borrow-requests/${request.id}/reject`, { reason: "  Schedule conflict  " }, admin.cookie);
  assert.equal(res.status, 200);
  const { request: decided } = await res.json();
  assert.equal(decided.status, "rejected");
  assert.equal(decided.decisionReason, "Schedule conflict");
  assert.equal(decided.decidedBy, admin.id);
  assert.match(decided.decidedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(decided.stock, 2);
  assert.equal(db.prepare("SELECT quantity FROM equipment WHERE id = ?").get(equipmentId).quantity, 2);

  const notice = db
    .prepare("SELECT type, message, reason FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1")
    .get(student.id);
  assert.equal(notice.type, "request_rejected");
  assert.equal(notice.message, "Request rejected. Dell Latitude. See the reason in My requests.");
  assert.equal(notice.reason, "Schedule conflict");

  const again = await call("POST", `/api/admin/borrow-requests/${request.id}/reject`, { reason: "Late" }, admin.cookie);
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: "Only pending requests can be rejected." });
});

test("a rejection needs a short reason", async (t) => {
  const { call, signup, addEquipment, createRequest } = await start(t);
  const admin = await signup("chan.nita@cadt.edu.kh", "admin");
  const student = await signup("sok.dara@student.cadt.edu.kh");
  const equipmentId = addEquipment("Dell Latitude", 2);
  const request = await createRequest(student, equipmentId);

  const missing = await call("POST", `/api/admin/borrow-requests/${request.id}/reject`, {}, admin.cookie);
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), {
    error: "A reason is required.",
    fields: { reason: "A reason is required." },
  });
  const long = await call("POST", `/api/admin/borrow-requests/${request.id}/reject`, { reason: "x".repeat(501) }, admin.cookie);
  assert.equal(long.status, 400);
  assert.match((await long.json()).error, /500 characters or fewer/);
});

test("students and guests cannot reach the admin borrow-request endpoints", async (t) => {
  const { call, signup, addEquipment, createRequest } = await start(t);
  const admin = await signup("chan.nita@cadt.edu.kh", "admin");
  const student = await signup("sok.dara@student.cadt.edu.kh");
  const equipmentId = addEquipment("Dell Latitude", 2);
  const request = await createRequest(student, equipmentId);
  const paths = [
    ["GET", "/api/admin/borrow-requests", undefined],
    ["POST", `/api/admin/borrow-requests/${request.id}/approve`, {}],
    ["POST", `/api/admin/borrow-requests/${request.id}/reject`, { reason: "No" }],
  ];
  for (const [method, path, body] of paths) {
    const denied = await call(method, path, body, student.cookie);
    assert.equal(denied.status, 403, `${method} ${path}`);
    assert.deepEqual(await denied.json(), { error: "Administrators only." });
    const guest = await call(method, path, body);
    assert.equal(guest.status, 401, `guest ${method} ${path}`);
    assert.deepEqual(await guest.json(), { error: "Please log in." });
  }
  assert.equal((await call("GET", "/api/admin/borrow-requests", undefined, admin.cookie)).status, 200);
});
