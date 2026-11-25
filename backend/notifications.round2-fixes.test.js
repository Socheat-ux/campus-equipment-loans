// Round 2 fixer checks: notify refuses to run outside a transaction, and mark-read accepts a bounded "all".
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb, withTransaction } from "./db.js";
import { createApp } from "./app.js";
import { notify } from "./notifications.js";

async function start(t) {
  const db = openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const post = (cookie, body) =>
    fetch(`${root}/api/notifications/read`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });
  const res = await fetch(`${root}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "sok.dara@student.cadt.edu.kh", password: "goodpass1" }),
  });
  const { user } = await res.json();
  return { db, post, id: user.id, cookie: res.headers.get("set-cookie").split(";")[0] };
}

test("notify outside withTransaction throws a TypeError that names withTransaction, and writes nothing", async (t) => {
  const { db, id } = await start(t);
  assert.throws(() => notify(db, { userId: id, type: "request_approved", message: "x" }), { name: "TypeError", message: /withTransaction/ });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 0);
  withTransaction(db, () => notify(db, { userId: id, type: "request_approved", message: "x" }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 1);
});

test('{ all: true, upTo } marks only ids up to upTo; bad upTo and stray keys are 400 and change nothing', async (t) => {
  const { db, post, id, cookie } = await start(t);
  const ids = withTransaction(db, () => [1, 2, 3, 4].map((n) => notify(db, { userId: id, type: "request_approved", message: `n${n}` })));
  const unread = () => db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL").get().n;

  for (const body of [
    { all: true, upTo: 0 }, { all: true, upTo: -1 }, { all: true, upTo: 1.5 }, { all: true, upTo: "3" },
    { all: true, upTo: null }, { all: true, upTo: [3] }, { all: false, upTo: 3 }, { upTo: 3 }, { ids: [1], upTo: 3 }, { all: true, upTo: 3, extra: 1 },
  ]) {
    assert.equal((await post(cookie, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(unread(), 4);

  const res = await post(cookie, { all: true, upTo: ids[1] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { unread: 2 }); // ids 3 and 4 arrived "after the last poll" and stay unread
  assert.equal((await post(cookie, { all: true, upTo: 2 ** 63 })).status, 200); // huge but valid: marks the rest, no 500
  assert.equal(unread(), 0);
});

test('{ "all": true } alone still marks everything', async (t) => {
  const { db, post, id, cookie } = await start(t);
  withTransaction(db, () => notify(db, { userId: id, type: "request_approved", message: "x" }));
  assert.deepEqual(await (await post(cookie, { all: true })).json(), { unread: 0 });
});
