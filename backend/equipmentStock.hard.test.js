import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { addDaysISO, todayISO } from "../shared/rules.js";
import { asCard } from "../frontend/src/equipment/cards.js";

const GOOD = "goodpass1";

async function start(t) {
  const db = await openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.close(); await db.close(); });
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
  await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminId);

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
  const approvedCount = async (id) =>
    (await db.prepare("SELECT COUNT(*)::int AS n FROM borrow_requests WHERE equipment_id = ? AND status = 'approved'").get(id)).n;
  return { db, item, edit, ask, approve, giveBack, row, approvedCount };
}

test("eight parallel approvals on two copies approve exactly two and leave none available", async (t) => {
  const h = await start(t);
  const id = await h.item(2);
  const requests = [];
  for (let i = 0; i < 8; i += 1) requests.push(await h.ask(id));

  const results = await Promise.all(requests.map(h.approve));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 409, 409, 409, 409, 409, 409]);
  assert.deepEqual({ ...(await h.row(id)) }, { quantity: 2, available: 0 });
  assert.equal(await h.approvedCount(id), 2);
});

test("approvals racing an edit that lowers the total never break the stock rules", async (t) => {
  const h = await start(t);
  const id = await h.item(3);
  const requests = [];
  for (let i = 0; i < 3; i += 1) requests.push(await h.ask(id));

  const [lowered, ...approvals] = await Promise.all([h.edit(id, 1), ...requests.map(h.approve)]);
  const { quantity, available } = await h.row(id);
  const onLoan = await h.approvedCount(id);
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
    assert.deepEqual({ ...(await h.row(id)) }, { quantity: total, available: shelf });
  }
  assert.equal((await h.edit(id, 0)).status, 400);
  for (const loan of loans) assert.equal((await h.giveBack(loan)).status, 200);
  assert.deepEqual({ ...(await h.row(id)) }, { quantity: 3, available: 3 });
});

test("a pending request cannot be approved after the total is edited down to 0", async (t) => {
  const h = await start(t);
  const id = await h.item(1);
  const request = await h.ask(id);
  assert.equal((await h.edit(id, 0)).status, 200);

  const refused = await h.approve(request);
  assert.equal(refused.status, 409);
  assert.deepEqual({ ...(await h.row(id)) }, { quantity: 0, available: 0 });
});

test("catalogue cards carry the shelf count and the total separately", () => {
  const card = asCard({ id: 7, name: "Tripod", category: "Camera", quantity: 3, available: 1 });
  assert.equal(card.stock, 1);
  assert.equal(card.total, 3);
  assert.equal(card.available, true);
  assert.equal(asCard({ id: 8, name: "Mic", category: "Audio", quantity: 2, available: 0 }).available, false);
});
