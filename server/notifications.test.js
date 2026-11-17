import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb, withTransaction } from "./db.js";
import { createApp } from "./app.js";
import { notify, LIST_LIMIT, MESSAGE_MAX, REASON_MAX } from "./notifications.js";

const GOOD = "goodpass1";
const student = (name) => `${name}@student.cadt.edu.kh`;

async function start(t) {
  const db = openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, { body, cookie, type = "application/json", raw } = {}) =>
    fetch(`${root}${path}`, {
      method,
      headers: {
        ...(body === undefined && raw === undefined ? {} : { "Content-Type": type }),
        ...(cookie ? { cookie } : {}),
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  // Returns the session cookie and the new user's id.
  const signup = async (name) => {
    const res = await call("POST", "/api/auth/signup", { body: { email: student(name), password: GOOD } });
    assert.equal(res.status, 201);
    const { user } = await res.json();
    return { cookie: res.headers.get("set-cookie").split(";")[0], id: user.id };
  };
  return { db, call, signup };
}

const list = async (call, cookie) => {
  const res = await call("GET", "/api/notifications", { cookie });
  assert.equal(res.status, 200);
  return res.json();
};

test("notify refuses bad input and stores a reason only on rejections", async (t) => {
  const { db, signup } = await start(t);
  const { id } = await signup("sok.dara");
  const bad = [
    { userId: 0, type: "request_approved", message: "x" },
    { userId: "1", type: "request_approved", message: "x" },
    { userId: id, type: "overdue", message: "x" },
    { userId: id, type: "request_approved", message: "   " },
    { userId: id, type: "request_approved", message: "x".repeat(MESSAGE_MAX + 1) },
    { userId: id, type: "request_rejected", message: "No" },
    { userId: id, type: "request_rejected", message: "No", reason: "  \n " },
    { userId: id, type: "request_rejected", message: "No", reason: "r".repeat(REASON_MAX + 1) },
  ];
  const inTx = (fn) => () => withTransaction(db, fn);
  for (const input of bad) assert.throws(inTx(() => notify(db, input)), TypeError, JSON.stringify(input).slice(0, 80));
  assert.throws(inTx(() => notify(db)), TypeError);
  // A user that does not exist breaks the foreign key.
  assert.throws(inTx(() => notify(db, { userId: 9999, type: "request_approved", message: "x" })));

  withTransaction(db, () => {
    notify(db, { userId: id, type: "request_approved", message: " Approved ", reason: "ignored" });
    notify(db, { userId: id, type: "request_rejected", message: "Rejected", reason: "  Item is under repair.  " });
  });
  const rows = db.prepare("SELECT type, message, reason FROM notifications ORDER BY id").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { type: "request_approved", message: "Approved", reason: null },
    { type: "request_rejected", message: "Rejected", reason: "Item is under repair." },
  ]);
});

test("guests get 401 and every answer is no-store", async (t) => {
  const { call } = await start(t);
  for (const res of [await call("GET", "/api/notifications"), await call("POST", "/api/notifications/read", { body: { all: true } })]) {
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
});

test("users see only their own notifications, newest first, with ISO times", async (t) => {
  const { db, call, signup } = await start(t);
  const a = await signup("sok.dara");
  const b = await signup("keo.bopha");
  withTransaction(db, () => {
    notify(db, { userId: a.id, type: "request_approved", message: "A first" });
    notify(db, { userId: b.id, type: "request_rejected", message: "B only", reason: "Broken" });
    notify(db, { userId: a.id, type: "request_rejected", message: "A second", reason: "Out of stock" });
  });
  // Same timestamp on purpose: the id breaks the tie, so the later row still comes first.
  db.prepare("UPDATE notifications SET created_at = '2026-11-12T01:00:00.000Z'").run();

  const mine = await list(call, a.cookie);
  assert.deepEqual(mine.notifications.map((n) => n.message), ["A second", "A first"]);
  assert.equal(mine.unread, 2);
  assert.equal(mine.notifications[0].reason, "Out of stock");
  assert.equal(mine.notifications[0].read, false);

  const theirs = await list(call, b.cookie);
  assert.deepEqual(theirs.notifications.map((n) => n.message), ["B only"]);

  withTransaction(db, () => notify(db, { userId: a.id, type: "request_approved", message: "A third" }));
  const fresh = await list(call, a.cookie);
  assert.equal(fresh.notifications[0].message, "A third");
  assert.match(fresh.notifications[0].createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(fresh.notifications[0].createdAt) - Date.now()) < 60_000);
});

test("the list stops at the limit but the unread count covers everything", async (t) => {
  const { db, call, signup } = await start(t);
  const a = await signup("sok.dara");
  withTransaction(db, () => {
    for (let i = 0; i < LIST_LIMIT + 5; i++) notify(db, { userId: a.id, type: "request_approved", message: `n${i}` });
  });
  const body = await list(call, a.cookie);
  assert.equal(body.notifications.length, LIST_LIMIT);
  assert.equal(body.notifications[0].message, `n${LIST_LIMIT + 4}`);
  assert.equal(body.unread, LIST_LIMIT + 5);
});

test("marking read touches only the caller's own rows", async (t) => {
  const { db, call, signup } = await start(t);
  const a = await signup("sok.dara");
  const b = await signup("keo.bopha");
  const [a1, a2, b1] = withTransaction(db, () => [
    notify(db, { userId: a.id, type: "request_approved", message: "a1" }),
    notify(db, { userId: a.id, type: "request_approved", message: "a2" }),
    notify(db, { userId: b.id, type: "request_approved", message: "b1" }),
  ]);

  // A tries to mark B's row: nothing happens to B.
  let res = await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { ids: [b1] } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).unread, 2);
  assert.equal((await list(call, b.cookie)).unread, 1);

  res = await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { ids: [a1, a1] } });
  assert.equal((await res.json()).unread, 1);
  const after = await list(call, a.cookie);
  assert.deepEqual(after.notifications.map((n) => [n.id, n.read]), [[a2, false], [a1, true]]);

  res = await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { all: true } });
  assert.equal((await res.json()).unread, 0);
  assert.equal((await list(call, b.cookie)).unread, 1);
});

test("mark-read refuses anything that is not a clean JSON object", async (t) => {
  const { db, call, signup } = await start(t);
  const a = await signup("sok.dara");
  withTransaction(db, () => notify(db, { userId: a.id, type: "request_approved", message: "keep me unread" }));
  const post = (opts) => call("POST", "/api/notifications/read", { cookie: a.cookie, ...opts });

  assert.equal((await post({ raw: "ids=1", type: "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await post({})).status, 415); // no body at all must not mean "mark everything"
  assert.equal((await post({ raw: "{not json" })).status, 400);
  for (const body of [[1], { ids: [] }, { ids: "1" }, { ids: [0] }, { ids: [-1] }, { ids: [1.5] }, { ids: ["1"] }, { ids: Array(LIST_LIMIT + 1).fill(1) }]) {
    assert.equal((await post({ body })).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await list(call, a.cookie)).unread, 1);
});

test("deleting a user deletes their notifications", async (t) => {
  const { db, signup } = await start(t);
  const a = await signup("sok.dara");
  withTransaction(db, () => notify(db, { userId: a.id, type: "request_approved", message: "bye" }));
  db.prepare("DELETE FROM users WHERE id = ?").run(a.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 0);
});

test("withTransaction keeps a status change and its notification together", async (t) => {
  const { db, signup } = await start(t);
  const a = await signup("sok.dara");
  db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Projector', 'Projector', 2)").run();
  const quantity = () => db.prepare("SELECT quantity FROM equipment").get().quantity;
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n;

  // notify fails (no reason), so the update before it must be undone too.
  assert.throws(() =>
    withTransaction(db, () => {
      db.prepare("UPDATE equipment SET quantity = 1").run();
      notify(db, { userId: a.id, type: "request_rejected", message: "No" });
    }),
  );
  assert.equal(quantity(), 2);
  assert.equal(count(), 0);

  // The connection is not left inside a transaction: the next one commits normally.
  const id = withTransaction(db, () => {
    db.prepare("UPDATE equipment SET quantity = 1").run();
    return notify(db, { userId: a.id, type: "request_approved", message: "Yes" });
  });
  assert.ok(id > 0);
  assert.equal(quantity(), 1);
  assert.equal(count(), 1);

  // An async function is refused, and its synchronous part is rolled back.
  assert.throws(
    () =>
      withTransaction(db, async () => {
        db.prepare("UPDATE equipment SET quantity = 0").run();
      }),
    /synchronous/,
  );
  assert.equal(quantity(), 1);
  assert.equal(withTransaction(db, () => "ok"), "ok");
});
