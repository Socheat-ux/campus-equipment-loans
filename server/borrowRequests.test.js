import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { addDaysISO, BORROW_MAX_DAYS, todayISO } from "./rules.js";

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
  const signup = async (name) => {
    const res = await call("POST", "/api/auth/signup", {
      email: `${name}@student.cadt.edu.kh`,
      password: GOOD,
    });
    assert.equal(res.status, 201);
    const { user } = await res.json();
    return { cookie: res.headers.get("set-cookie").split(";")[0], id: user.id, fullName: user.fullName };
  };
  const makeAdmin = (user) => {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    return user;
  };
  const addEquipment = (name, quantity) =>
    Number(
      db.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Laptop', ?)").run(name, quantity)
        .lastInsertRowid,
    );
  return { db, call, signup, makeAdmin, addEquipment };
}

test("a student can submit a request, which is saved pending and creates a notification", async (t) => {
  const { db, call, signup, makeAdmin, addEquipment } = await start(t);
  const student = await signup("sok.dara");
  const admin = await makeAdmin(await signup("chan.nita"));
  const equipmentId = addEquipment("Dell Latitude", 2);
  const borrowDate = addDaysISO(todayISO(), 1);

  const res = await call(
    "POST",
    "/api/borrow-requests",
    { equipmentId, borrowDate, purpose: "  Final year project  " },
    student.cookie,
  );
  assert.equal(res.status, 201);
  const { request } = await res.json();
  assert.deepEqual(request, {
    id: request.id,
    equipmentId,
    equipmentName: "Dell Latitude",
    equipmentCategory: "Laptop",
    equipmentLocation: "Main store",
    userId: student.id,
    borrowDate,
    returnDate: addDaysISO(borrowDate, BORROW_MAX_DAYS),
    purpose: "Final year project",
    status: "pending",
    createdAt: request.createdAt,
    decisionReason: null,
    returnedAt: null,
  });

  const row = db.prepare("SELECT * FROM borrow_requests WHERE id = ?").get(request.id);
  assert.equal(row.status, "pending");
  assert.equal(row.user_id, student.id);
  assert.equal(row.return_date, addDaysISO(borrowDate, BORROW_MAX_DAYS));
  // Stock is untouched until staff approval.
  assert.equal(db.prepare("SELECT available FROM equipment WHERE id = ?").get(equipmentId).available, 2);

  const notice = db
    .prepare("SELECT type, message FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1")
    .get(student.id);
  assert.equal(notice.type, "request_submitted");
  assert.equal(notice.message, "Your request for Dell Latitude was submitted and is awaiting approval.");

  const adminNotice = db
    .prepare("SELECT type, message FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1")
    .get(admin.id);
  assert.equal(adminNotice.type, "request_submitted");
  assert.equal(adminNotice.message, `New borrow request from ${student.fullName} for Dell Latitude.`);

  const list = await call("GET", "/api/borrow-requests", undefined, student.cookie);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).requests.map((item) => item.id), [request.id]);

  const other = await signup("keo.bopha");
  const otherList = await call("GET", "/api/borrow-requests", undefined, other.cookie);
  assert.deepEqual((await otherList.json()).requests, []);
});

test("every administrator is notified when a request is submitted", async (t) => {
  const { db, call, signup, makeAdmin, addEquipment } = await start(t);
  const student = await signup("sok.dara");
  const firstAdmin = await makeAdmin(await signup("chan.nita"));
  const secondAdmin = await makeAdmin(await signup("meas.sophea"));
  const borrower = await signup("keo.bopha");
  const equipmentId = addEquipment("Epson Projector", 1);

  const res = await call(
    "POST",
    "/api/borrow-requests",
    { equipmentId, borrowDate: addDaysISO(todayISO(), 1) },
    student.cookie,
  );
  assert.equal(res.status, 201);

  for (const admin of [firstAdmin, secondAdmin]) {
    const notices = db
      .prepare("SELECT type, message FROM notifications WHERE user_id = ?")
      .all(admin.id)
      .map((row) => ({ type: row.type, message: row.message }));
    assert.deepEqual(notices, [
      {
        type: "request_submitted",
        message: `New borrow request from ${student.fullName} for Epson Projector.`,
      },
    ]);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?").get(borrower.id).n, 0);
});

test("an unavailable item is rejected and nothing is saved", async (t) => {
  const { db, call, signup, addEquipment } = await start(t);
  const student = await signup("sok.dara");
  const equipmentId = addEquipment("Checked out camera", 0);

  const res = await call(
    "POST",
    "/api/borrow-requests",
    { equipmentId, borrowDate: addDaysISO(todayISO(), 1) },
    student.cookie,
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: "This item is no longer available.",
    fields: { equipmentId: "This item is no longer available." },
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM borrow_requests").get().n, 0);
});

test("a past borrow date is rejected", async (t) => {
  const { db, call, signup, addEquipment } = await start(t);
  const student = await signup("sok.dara");
  const equipmentId = addEquipment("Projector", 1);

  const res = await call("POST", "/api/borrow-requests", { equipmentId, borrowDate: "2000-01-01" }, student.cookie);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.fields.borrowDate, "Borrow date cannot be in the past.");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM borrow_requests").get().n, 0);
});

test("submitting without a session is rejected", async (t) => {
  const { call, addEquipment } = await start(t);
  const equipmentId = addEquipment("Projector", 1);

  const res = await call("POST", "/api/borrow-requests", {
    equipmentId,
    borrowDate: addDaysISO(todayISO(), 1),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Please log in." });
});

test("a borrower reads only their own request, and cannot choose the return date", async (t) => {
  const { call, signup, addEquipment } = await start(t);
  const owner = await signup("sok.dara");
  const other = await signup("keo.bopha");
  const equipmentId = addEquipment("Microscope", 1);
  const borrowDate = addDaysISO(todayISO(), 2);

  const created = await call(
    "POST",
    "/api/borrow-requests",
    { equipmentId, borrowDate, returnDate: "2030-01-01", purpose: "Lab work" },
    owner.cookie,
  );
  assert.equal(created.status, 201);
  const { request } = await created.json();
  assert.equal(request.returnDate, addDaysISO(borrowDate, BORROW_MAX_DAYS));

  const own = await call("GET", `/api/borrow-requests/${request.id}`, undefined, owner.cookie);
  assert.equal(own.status, 200);
  assert.equal((await own.json()).request.id, request.id);
  const someoneElse = await call("GET", `/api/borrow-requests/${request.id}`, undefined, other.cookie);
  assert.equal(someoneElse.status, 404);
  assert.deepEqual(await someoneElse.json(), { error: "Request not found." });
});

test("a borrower can cancel their own pending request, and it is notified without changing stock", async (t) => {
  const { db, call, signup, addEquipment } = await start(t);
  const student = await signup("sok.dara");
  const equipmentId = addEquipment("Canon DSLR", 2);
  const borrowDate = addDaysISO(todayISO(), 1);

  const created = await call("POST", "/api/borrow-requests", { equipmentId, borrowDate, purpose: "Photos" }, student.cookie);
  assert.equal(created.status, 201);
  const { request } = await created.json();

  const res = await call("POST", `/api/borrow-requests/${request.id}/cancel`, {}, student.cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.request.status, "cancelled");
  assert.equal(body.request.id, request.id);
  assert.equal(db.prepare("SELECT status FROM borrow_requests WHERE id = ?").get(request.id).status, "cancelled");
  assert.equal(db.prepare("SELECT available FROM equipment WHERE id = ?").get(equipmentId).available, 2);

  const notice = db
    .prepare("SELECT type, message FROM notifications WHERE user_id = ? AND request_id = ? ORDER BY id DESC LIMIT 1")
    .get(student.id, request.id);
  assert.equal(notice.type, "request_cancelled");
  assert.equal(notice.message, "Your request for Canon DSLR was cancelled.");
});

test("a borrower cannot cancel someone else's request or a non-pending request", async (t) => {
  const { db, call, signup, addEquipment } = await start(t);
  const owner = await signup("sok.dara");
  const other = await signup("keo.bopha");
  const equipmentId = addEquipment("Projector", 1);
  const borrowDate = addDaysISO(todayISO(), 1);

  const created = await call("POST", "/api/borrow-requests", { equipmentId, borrowDate }, owner.cookie);
  const { request } = await created.json();

  const someoneElse = await call("POST", `/api/borrow-requests/${request.id}/cancel`, {}, other.cookie);
  assert.equal(someoneElse.status, 404);
  assert.deepEqual(await someoneElse.json(), { error: "Request not found." });

  for (const status of ["approved", "rejected", "returned", "cancelled"]) {
    db.prepare("UPDATE borrow_requests SET status = ? WHERE id = ?").run(status, request.id);
    const res = await call("POST", `/api/borrow-requests/${request.id}/cancel`, {}, owner.cookie);
    assert.equal(res.status, 409, status);
    assert.deepEqual(await res.json(), { error: "Only pending requests can be cancelled." });
  }
});

test("cancelling requires a signed-in borrower and a JSON body", async (t) => {
  const { db, call, signup, addEquipment } = await start(t);
  const student = await signup("sok.dara");
  const equipmentId = addEquipment("Tripod", 1);
  const created = await call("POST", "/api/borrow-requests", { equipmentId, borrowDate: addDaysISO(todayISO(), 1) }, student.cookie);
  const { request } = await created.json();

  const guest = await call("POST", `/api/borrow-requests/${request.id}/cancel`, {});
  assert.equal(guest.status, 401);
  assert.deepEqual(await guest.json(), { error: "Please log in." });

  const wrongType = await call("POST", `/api/borrow-requests/${request.id}/cancel`, undefined, student.cookie);
  assert.equal(wrongType.status, 415);
  assert.deepEqual(await wrongType.json(), { error: "JSON only." });
  assert.equal(db.prepare("SELECT status FROM borrow_requests WHERE id = ?").get(request.id).status, "pending");
});

test("bad fields and a non-JSON body are refused before saving anything", async (t) => {
  const { db, call, signup, addEquipment } = await start(t);
  const student = await signup("sok.dara");
  const equipmentId = addEquipment("Projector", 1);

  const res = await call(
    "POST",
    "/api/borrow-requests",
    { equipmentId: 0, borrowDate: "not-a-date", purpose: "x".repeat(501) },
    student.cookie,
  );
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys((await res.json()).fields).sort(), ["borrowDate", "equipmentId", "purpose"]);

  const wrongType = await call("POST", "/api/borrow-requests", undefined, student.cookie);
  assert.equal(wrongType.status, 415);
  assert.deepEqual(await wrongType.json(), { error: "JSON only." });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM borrow_requests").get().n, 0);
});
