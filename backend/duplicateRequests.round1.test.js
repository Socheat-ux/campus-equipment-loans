// SCRUM-46 round 1: adversarial cases the first tests missed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest, Agent } from "node:http";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { addDaysISO, todayISO } from "../shared/rules.js";

const GOOD = "goodpass1";
const tomorrow = () => addDaysISO(todayISO(), 1);
const message = (item, date) => `You already have a pending request for ${item} starting ${date}. Cancel it in My requests or wait for a decision.`;

async function start(t) {
  const db = openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = server.address().port;
  const root = `http://127.0.0.1:${port}`;
  const call = async (method, path, cookie, body) => {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
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
  const admin = await signup("nhem.sokha@cadt.edu.kh");
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  const item = (name, quantity = 3) =>
    Number(db.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Camera', ?)").run(name, quantity).lastInsertRowid);
  const ask = (user, equipmentId, borrowDate = tomorrow()) =>
    call("POST", "/api/borrow-requests", user.cookie, { equipmentId, borrowDate, purpose: "Lab work" });
  const adminDo = (id, action, body) => call("POST", `/api/admin/borrow-requests/${id}/${action}`, admin.cookie, body);
  const pendingIds = (user, equipmentId) =>
    db
      .prepare("SELECT id FROM borrow_requests WHERE user_id = ? AND equipment_id = ? AND status = 'pending' ORDER BY id")
      .all(user.id, equipmentId)
      .map((r) => r.id);
  // A row written straight to the table, the way a database from before SCRUM-46 could hold it.
  const legacyPending = (user, equipmentId, date = tomorrow()) =>
    Number(
      db
        .prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, status) VALUES (?, ?, ?, ?, 'pending')")
        .run(equipmentId, user.id, date, addDaysISO(date, 7)).lastInsertRowid,
    );
  return { db, port, call, signup, item, ask, adminDo, pendingIds, legacyPending };
}

test("legacy duplicates: the 409 names the oldest, each can be cancelled, and only then is a new request accepted", async (t) => {
  const h = await start(t);
  const student = await h.signup("touch.sovann@student.cadt.edu.kh");
  const camera = h.item("Canon camera");
  const day = tomorrow();
  const [a, b] = [h.legacyPending(student, camera, day), h.legacyPending(student, camera, day)];

  const refused = await h.ask(student, camera, day);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.existingRequestId, a, "the oldest pending request is named");
  assert.equal(refused.body.error, message("Canon camera", day));

  assert.equal((await h.call("POST", `/api/borrow-requests/${a}/cancel`, student.cookie, {})).status, 200);
  const stillRefused = await h.ask(student, camera, day);
  assert.equal(stillRefused.status, 409, "the second legacy duplicate still blocks");
  assert.equal(stillRefused.body.existingRequestId, b);

  assert.equal((await h.call("POST", `/api/borrow-requests/${b}/cancel`, student.cookie, {})).status, 200);
  assert.equal((await h.ask(student, camera, day)).status, 201);
  assert.equal(h.pendingIds(student, camera).length, 1);
});

test("an approved loan does not block a new request for the same item, and the new one is still limited to one", async (t) => {
  const h = await start(t);
  const student = await h.signup("yim.sreypov@student.cadt.edu.kh");
  const kit = h.item("Raspberry Pi kit", 3);
  const first = await h.ask(student, kit);
  assert.equal((await h.adminDo(first.body.request.id, "approve")).status, 200);

  assert.equal((await h.ask(student, kit)).status, 201, "holding a loan is not a pending request");
  const third = await h.ask(student, kit);
  assert.equal(third.status, 409);
  assert.notEqual(third.body.existingRequestId, first.body.request.id, "the approved loan is never named");
});

test("order of refusals: fields, then unknown item, then the duplicate, then stock; nothing is written", async (t) => {
  const h = await start(t);
  const student = await h.signup("chan.dalin@student.cadt.edu.kh");
  const lens = h.item("Sigma lens", 1);
  const day = tomorrow();
  const mine = await h.ask(student, lens, day);
  assert.equal(mine.status, 201);

  const badDate = await h.ask(student, lens, "2020-01-01");
  assert.equal(badDate.status, 400, "field errors are reported first");
  assert.equal(badDate.body.existingRequestId, undefined);

  const missing = await h.ask(student, 999999);
  assert.equal(missing.status, 404);

  // Another student takes the only copy; the item is out of stock but the first student still has a pending request.
  const other = await h.signup("pen.rotha@student.cadt.edu.kh");
  assert.equal((await h.adminDo((await h.ask(other, lens, day)).body.request.id, "approve")).status, 200);
  const empty = await h.ask(student, lens, day);
  assert.equal(empty.status, 409, "the duplicate rule wins over the stock rule");
  assert.deepEqual(empty.body, { error: message("Sigma lens", day), existingRequestId: mine.body.request.id });
  assert.deepEqual(h.pendingIds(student, lens), [mine.body.request.id]);

  // A student with no pending request still hears that the item is out of stock.
  const third = await h.signup("sam.nika@student.cadt.edu.kh");
  const none = await h.ask(third, lens, day);
  assert.equal(none.status, 400);
  assert.equal(none.body.existingRequestId, undefined);
  assert.deepEqual(h.pendingIds(third, lens), []);
});

test("a student cannot learn about someone else's request: the 409 only ever names the caller's own row and date", async (t) => {
  const h = await start(t);
  const one = await h.signup("so.vichea@student.cadt.edu.kh");
  const two = await h.signup("ouk.chanthy@student.cadt.edu.kh");
  const tripod = h.item("Manfrotto tripod");
  const theirDate = addDaysISO(todayISO(), 3);
  const day = tomorrow();
  const theirs = await h.ask(two, tripod, theirDate);
  const mine = await h.ask(one, tripod, day);
  assert.equal(mine.status, 201);

  const again = await h.ask(one, tripod, day);
  assert.equal(again.status, 409);
  assert.equal(again.body.existingRequestId, mine.body.request.id);
  assert.notEqual(again.body.existingRequestId, theirs.body.request.id);
  assert.equal(again.body.error, message("Manfrotto tripod", day));
  assert.ok(!again.body.error.includes(theirDate));
  assert.equal((await h.call("GET", `/api/borrow-requests/${again.body.existingRequestId}`, one.cookie)).status, 200);
});

test("20 requests on warm keep-alive sockets, released in the same tick, still leave exactly one pending row", async (t) => {
  const h = await start(t);
  const student = await h.signup("heng.bopha@student.cadt.edu.kh");
  const kit = h.item("Arduino kit", 5);
  const agent = new Agent({ keepAlive: true, maxSockets: 20 });
  t.after(() => agent.destroy());
  const send = (method, path, body) =>
    new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : undefined;
      const req = httpRequest(
        { host: "127.0.0.1", port: h.port, method, path, agent, headers: { cookie: student.cookie, "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  // Open 20 sockets first, so the POSTs do not wait on TCP handshakes and land together.
  await Promise.all(Array.from({ length: 20 }, () => send("GET", "/api/borrow-requests")));
  const statuses = await Promise.all(
    Array.from({ length: 20 }, () => send("POST", "/api/borrow-requests", { equipmentId: kit, borrowDate: tomorrow(), purpose: "Lab work" })),
  );
  assert.equal(statuses.filter((s) => s === 201).length, 1);
  assert.equal(statuses.filter((s) => s === 409).length, 19);
  assert.equal(h.pendingIds(student, kit).length, 1);
});
