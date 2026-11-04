import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb } from "./db.js";
import { createApp } from "./app.js";

const GOOD = "goodpass1";
const student = (name) => `${name}@student.cadt.edu.kh`;

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
  const signup = async (email) => {
    const res = await call("POST", "/api/auth/signup", { email, password: GOOD });
    assert.equal(res.status, 201);
    return res.headers.get("set-cookie").split(";")[0];
  };
  return { db, call, signup };
}

test("equipment API is administrator-only and validates each field", async (t) => {
  const { db, call, signup } = await start(t);
  const studentCookie = await signup(student("sok.dara"));
  const adminCookie = await signup(student("keo.bopha"));
  db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(student("keo.bopha"));

  assert.equal((await call("GET", "/api/equipment")).status, 401);
  assert.equal((await call("GET", "/api/equipment", undefined, studentCookie)).status, 200);

  const empty = await call("GET", "/api/equipment", undefined, adminCookie);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { equipment: [] });

  const bad = await call("POST", "/api/equipment", { name: " ", category: "Nope", quantity: -1 }, adminCookie);
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.equal(badBody.error, "Please fix the fields below.");
  assert.deepEqual(Object.keys(badBody.fields).sort(), ["category", "name", "quantity"]);
  assert.equal(badBody.fields.quantity, "Quantity must be 0 or more.");

  assert.equal(
    (await call("POST", "/api/equipment", { name: "Projector", category: "Projector", quantity: 2 }, studentCookie)).status,
    403,
  );

  const created = await call(
    "POST",
    "/api/equipment",
    { name: "  Epson projector  ", category: "Projector", quantity: 2 },
    adminCookie,
  );
  assert.equal(created.status, 201);
  const item = (await created.json()).equipment;
  assert.deepEqual(item, { id: item.id, name: "Epson projector", category: "Projector", quantity: 2 });

  assert.equal((await call("GET", `/api/equipment/${item.id}`, undefined, adminCookie)).status, 200);
  assert.equal((await call("GET", "/api/equipment/9999", undefined, adminCookie)).status, 404);

  const badEdit = await call(
    "PUT",
    `/api/equipment/${item.id}`,
    { name: "Projector", category: "Projector", quantity: 1.5 },
    adminCookie,
  );
  assert.equal(badEdit.status, 400);
  assert.deepEqual((await badEdit.json()).fields, { quantity: "Quantity must be a whole number." });

  const edited = await call(
    "PUT",
    `/api/equipment/${item.id}`,
    { name: "Epson projector", category: "Audio", quantity: 0 },
    adminCookie,
  );
  assert.equal(edited.status, 200);
  assert.deepEqual((await edited.json()).equipment, { id: item.id, name: "Epson projector", category: "Audio", quantity: 0 });

  const list = await call("GET", "/api/equipment", undefined, adminCookie);
  assert.deepEqual((await list.json()).equipment, [
    { id: item.id, name: "Epson projector", category: "Audio", quantity: 0 },
  ]);
});
