// SCRUM-46: one pending request per user per item.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { addDaysISO, todayISO } from "../shared/rules.js";

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
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  const item = (name, quantity = 3) =>
    Number(db.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Camera', ?)").run(name, quantity).lastInsertRowid);
  const ask = (user, equipmentId, borrowDate = addDaysISO(todayISO(), 1)) =>
    call("POST", "/api/borrow-requests", user.cookie, { equipmentId, borrowDate, purpose: "Club event" });
  const adminDo = (id, action, body) => call("POST", `/api/admin/borrow-requests/${id}/${action}`, admin.cookie, body);
  const pending = (user, equipmentId) =>
    db.prepare("SELECT COUNT(*) AS n FROM borrow_requests WHERE user_id = ? AND equipment_id = ? AND status = 'pending'").get(user.id, equipmentId).n;
  const notices = () => db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n;
  return { db, call, signup, item, ask, adminDo, pending, notices };
}

test("a second pending request for the same item gets a 409 that names the first one, and nothing is written", async (t) => {
  const h = await start(t);
  const student = await h.signup("meas.rithy@student.cadt.edu.kh");
  const camera = h.item("Canon EOS 250D Camera");
  const day = addDaysISO(todayISO(), 1); // fixed once so a midnight rollover cannot split the request from the message
  const first = await h.ask(student, camera, day);
  assert.equal(first.status, 201);
  const noticesBefore = h.notices();

  const second = await h.ask(student, camera, day);
  assert.equal(second.status, 409);
  assert.deepEqual(second.body, {
    error: `You already have a pending request for Canon EOS 250D Camera starting ${day}. Cancel it in My requests or wait for a decision.`,
    existingRequestId: first.body.request.id,
  });
  assert.equal(h.pending(student, camera), 1);
  assert.equal(h.notices(), noticesBefore, "a refused request sends no notices");
});

test("after the pending request is cancelled, rejected or returned, a new one is accepted", async (t) => {
  const h = await start(t);
  const student = await h.signup("chea.dara@student.cadt.edu.kh");
  const camera = h.item("Sony camera");
  const id = async () => {
    const res = await h.ask(student, camera);
    assert.equal(res.status, 201);
    assert.equal((await h.ask(student, camera)).status, 409);
    return res.body.request.id;
  };

  const cancelled = await id();
  assert.equal((await h.call("POST", `/api/borrow-requests/${cancelled}/cancel`, student.cookie, {})).status, 200);

  const rejected = await id();
  assert.equal((await h.adminDo(rejected, "reject", { reason: "Booked by the media club." })).status, 200);

  const returned = await id();
  assert.equal((await h.adminDo(returned, "approve")).status, 200);
  assert.equal((await h.adminDo(returned, "return")).status, 200);
  assert.equal((await h.ask(student, camera)).status, 201);
  assert.equal(h.pending(student, camera), 1);
});

test("10 parallel requests for the same item leave exactly one pending request", async (t) => {
  const h = await start(t);
  const student = await h.signup("pich.sreyleak@student.cadt.edu.kh");
  const kit = h.item("Arduino kit", 5);

  const results = await Promise.all(Array.from({ length: 10 }, () => h.ask(student, kit)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
  assert.equal(h.pending(student, kit), 1);
});

test("the rule is per user and per item: another item, another student and a faculty member are not blocked", async (t) => {
  const h = await start(t);
  const student = await h.signup("ros.vanna@student.cadt.edu.kh");
  const other = await h.signup("sok.malis@student.cadt.edu.kh");
  const faculty = await h.signup("kem.vuthy@cadt.edu.kh");
  const camera = h.item("Nikon camera");
  const tripod = h.item("Tripod");

  assert.equal((await h.ask(student, camera)).status, 201);
  assert.equal((await h.ask(student, tripod)).status, 201);
  assert.equal((await h.ask(other, camera)).status, 201);
  assert.equal((await h.ask(faculty, camera)).status, 201);
  assert.equal((await h.ask(faculty, camera)).status, 409, "faculty follow the same rule");
});
