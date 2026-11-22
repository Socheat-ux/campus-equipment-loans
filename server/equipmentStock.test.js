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
  const call = async (method, path, cookie, body) => {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  const signup = async (email) => {
    const res = await fetch(`${root}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: GOOD }),
    });
    assert.equal(res.status, 201);
    const { user } = await res.json();
    return { id: user.id, cookie: res.headers.get("set-cookie").split(";")[0] };
  };
  const admin = await signup("chan.nita@cadt.edu.kh");
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);

  const addItem = async (quantity) => {
    const res = await call("POST", "/api/equipment", admin.cookie, { name: "Epson projector", category: "Projector", quantity });
    assert.equal(res.status, 201);
    return res.body.equipment.id;
  };
  const edit = (id, quantity) =>
    call("PUT", `/api/equipment/${id}`, admin.cookie, { name: "Epson projector", category: "Projector", quantity });
  // Each loan comes from a different student so the request rules never get in the way.
  let students = 0;
  const lend = async (equipmentId) => {
    students += 1;
    const student = await signup(`sok.dara${students}@student.cadt.edu.kh`);
    const made = await call("POST", "/api/borrow-requests", student.cookie, {
      equipmentId,
      borrowDate: addDaysISO(todayISO(), 1),
      purpose: "Class presentation",
    });
    assert.equal(made.status, 201);
    const approved = await call("POST", `/api/admin/borrow-requests/${made.body.request.id}/approve`, admin.cookie, {});
    assert.equal(approved.status, 200);
    return made.body.request.id;
  };
  const giveBack = async (requestId) =>
    assert.equal((await call("POST", `/api/admin/borrow-requests/${requestId}/return`, admin.cookie, {})).status, 200);
  const stock = async (id) => {
    const { quantity, available } = (await call("GET", `/api/equipment/${id}`)).body.equipment;
    return { quantity, available };
  };
  return { db, addItem, edit, lend, giveBack, stock };
}

test("the card's steps end with 3 owned and 3 available after the return", async (t) => {
  const { addItem, edit, lend, giveBack, stock } = await start(t);
  const id = await addItem(2);
  const loan = await lend(id);
  assert.deepEqual(await stock(id), { quantity: 2, available: 1 });

  const edited = await edit(id, 3);
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.equipment, { id, name: "Epson projector", category: "Projector", quantity: 3, available: 2 });

  await giveBack(loan);
  assert.deepEqual(await stock(id), { quantity: 3, available: 3 });
});

test("the total can drop to exactly the number on loan, leaving none on the shelf", async (t) => {
  const { addItem, edit, lend, giveBack, stock } = await start(t);
  const id = await addItem(4);
  const first = await lend(id);
  const second = await lend(id);

  assert.equal((await edit(id, 2)).status, 200);
  assert.deepEqual(await stock(id), { quantity: 2, available: 0 });

  await giveBack(first);
  await giveBack(second);
  assert.deepEqual(await stock(id), { quantity: 2, available: 2 });
});

test("a total below the number on loan is refused and changes nothing", async (t) => {
  const { db, addItem, edit, lend, stock } = await start(t);
  const id = await addItem(3);
  await lend(id);
  await lend(id);
  const before = db.prepare("SELECT * FROM equipment WHERE id = ?").get(id);

  const refused = await edit(id, 1);
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body.fields, { quantity: "Total cannot be lower than the 2 items on loan." });
  assert.deepEqual(db.prepare("SELECT * FROM equipment WHERE id = ?").get(id), before);
  assert.deepEqual(await stock(id), { quantity: 3, available: 1 });
});

test("one item on loan gets the singular message, and zero on loan allows a total of 0", async (t) => {
  const { addItem, edit, lend, giveBack, stock } = await start(t);
  const id = await addItem(1);
  const loan = await lend(id);
  assert.deepEqual((await edit(id, 0)).body.fields, { quantity: "Total cannot be lower than the 1 item on loan." });

  await giveBack(loan);
  assert.equal((await edit(id, 0)).status, 200);
  assert.deepEqual(await stock(id), { quantity: 0, available: 0 });
});
