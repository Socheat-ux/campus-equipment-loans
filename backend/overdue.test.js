import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { addDaysISO, todayISO } from "../shared/rules.js";

test("admin overdue list includes only approved loans past their return date", async (t) => {
  const db = await openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await db.close();
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, cookie) => fetch(`${root}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const signup = async (email) => {
    const response = await call("POST", "/api/auth/signup", { email, password: "goodpass1" });
    assert.equal(response.status, 201);
    return { id: (await response.json()).user.id, cookie: response.headers.get("set-cookie").split(";")[0] };
  };
  const admin = await signup("chan.nita@cadt.edu.kh");
  const student = await signup("sok.dara@student.cadt.edu.kh");
  await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  const equipmentId = Number((await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Demo Laptop', 'Laptop', 1) RETURNING id").run()).lastInsertRowid);
  const today = todayISO();
  const insertLoan = db.prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, status) VALUES (?, ?, ?, ?, ?)");
  await insertLoan.run(equipmentId, student.id, addDaysISO(today, -9), addDaysISO(today, -2), "approved");
  await insertLoan.run(equipmentId, student.id, addDaysISO(today, -8), today, "approved");
  await insertLoan.run(equipmentId, student.id, addDaysISO(today, -9), addDaysISO(today, -2), "pending");
  await insertLoan.run(equipmentId, student.id, addDaysISO(today, -9), addDaysISO(today, -2), "returned");

  const guest = await call("GET", "/api/admin/overdue");
  assert.equal(guest.status, 401);
  const forbidden = await call("GET", "/api/admin/overdue", undefined, student.cookie);
  assert.equal(forbidden.status, 403);
  const response = await call("GET", "/api/admin/overdue", undefined, admin.cookie);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();
  assert.equal(data.today, today);
  assert.equal(data.overdue.length, 1);
  assert.deepEqual(data.overdue[0], {
    id: 1,
    equipmentId,
    equipmentName: "Demo Laptop",
    equipmentAssetId: `CG-${String(equipmentId).padStart(4, "0")}`,
    equipmentCategory: "Laptop",
    equipmentLocation: "Main store",
    userId: student.id,
    requesterName: "Sok Dara",
    requesterEmail: "sok.dara@student.cadt.edu.kh",
    borrowDate: addDaysISO(today, -9),
    returnDate: addDaysISO(today, -2),
    daysOverdue: 2,
    purpose: null,
    createdAt: data.overdue[0].createdAt,
  });
});
