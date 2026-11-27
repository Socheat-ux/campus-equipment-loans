import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb } from "./db.js";
import { createApp } from "./app.js";

const GOOD = "goodpass1";

async function start(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  return (method, path, cookie, body) =>
    fetch(`${root}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function seeded(t) {
  const db = await openDb(":memory:");
  const call = await start(t, createApp(db));
  t.after(() => db.close());
  const signup = async (email) => {
    const res = await call("POST", "/api/auth/signup", undefined, { email, password: GOOD });
    assert.equal(res.status, 201, email);
    const { user } = await res.json();
    return { user, cookie: res.headers.get("set-cookie").split(";")[0] };
  };
  const student = await signup("sok.dara@student.cadt.edu.kh");
  const faculty = await signup("keo.bopha@cadt.edu.kh");
  const admin = await signup("chan.nita@cadt.edu.kh");
  await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.user.id);
  return { db, call, student, faculty, admin };
}

test("listing accounts is admin-only and never exposes password hashes", async (t) => {
  const { call, student, faculty, admin } = await seeded(t);
  assert.equal((await call("GET", "/api/users")).status, 401);
  for (const who of [student, faculty]) {
    const res = await call("GET", "/api/users", who.cookie);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Administrators only." });
  }

  const res = await call("GET", "/api/users", admin.cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { users } = await res.json();
  assert.equal(users.length, 3);
  assert.deepEqual(Object.keys(users[0]).sort(), ["createdAt", "email", "fullName", "id", "role"]);
  assert.ok(users.every((row) => typeof row.id === "number" && !("password_hash" in row) && !("passwordHash" in row)));
  assert.deepEqual(
    users.map((row) => row.role),
    ["admin", "faculty", "student"], // ordered by full name: Chan, Keo, Sok
  );
  assert.deepEqual(users.find((row) => row.email === student.user.email)?.fullName, "Sok Dara");
});

test("an administrator can promote and demote an account; the session sees the new role at once", async (t) => {
  const { call, student, admin } = await seeded(t);

  const promoted = await call("PATCH", `/api/users/${student.user.id}/role`, admin.cookie, { role: "admin" });
  assert.equal(promoted.status, 200);
  const body = await promoted.json();
  assert.deepEqual(
    { id: body.user.id, email: body.user.email, fullName: body.user.fullName, role: body.user.role },
    { ...student.user, role: "admin" },
  );
  assert.equal(typeof body.user.createdAt, "string");
  assert.equal((await (await call("GET", "/api/auth/me", student.cookie)).json()).user.role, "admin");
  const write = await call("POST", "/api/equipment", student.cookie, { name: "Tripod", category: "Camera", quantity: 2 });
  assert.equal(write.status, 201, "the promoted account can now use an admin route");

  const demoted = await call("PATCH", `/api/users/${student.user.id}/role`, admin.cookie, { role: "faculty" });
  assert.equal(demoted.status, 200);
  assert.equal((await demoted.json()).user.role, "faculty");
  assert.equal((await (await call("GET", "/api/auth/me", student.cookie)).json()).user.role, "faculty");
  assert.equal((await call("PUT", "/api/equipment/1", student.cookie, { name: "Tripod", category: "Camera", quantity: 3 })).status, 403);
  assert.equal((await (await call("GET", "/api/users", admin.cookie)).json()).users.find((u) => u.id === student.user.id).role, "faculty");
});

test("bad roles, missing users and non-JSON writes are refused; other roles cannot reach the write at all", async (t) => {
  const { db, call, student, admin } = await seeded(t);
  const path = `/api/users/${student.user.id}/role`;

  for (const role of ["Admin", "staff", "", null, 1, undefined]) {
    const res = await call("PATCH", path, admin.cookie, { role });
    assert.equal(res.status, 400, JSON.stringify(role));
    const body = await res.json();
    assert.match(body.fields.role, /student, faculty, admin/);
  }
  assert.equal((await call("PATCH", "/api/users/9999/role", admin.cookie, { role: "admin" })).status, 404);
  assert.equal((await call("PATCH", "/api/users/not-a-number/role", admin.cookie, { role: "admin" })).status, 404);
  assert.equal((await call("PATCH", path, admin.cookie)).status, 415, "a request with no JSON body");
  assert.equal((await db.prepare("SELECT role FROM users WHERE id = ?").get(student.user.id)).role, "student");

  for (const who of [undefined, student.cookie]) {
    const res = await call("PATCH", path, who, { role: "admin" });
    assert.ok([401, 403].includes(res.status));
  }
  assert.equal((await db.prepare("SELECT role FROM users WHERE id = ?").get(student.user.id)).role, "student");
  assert.equal((await call("POST", "/api/users", admin.cookie, { role: "admin" })).status, 404, "no such route");
});

test("the last administrator cannot be demoted, but a second one can", async (t) => {
  const { db, call, faculty, admin } = await seeded(t);
  const set = (id, role) => call("PATCH", `/api/users/${id}/role`, admin.cookie, { role });

  const blocked = await set(admin.user.id, "student");
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { error: "At least one administrator must remain." });
  assert.equal((await db.prepare("SELECT role FROM users WHERE id = ?").get(admin.user.id)).role, "admin");

  assert.equal((await set(faculty.user.id, "admin")).status, 200, "a second administrator is allowed");
  const nowSecond = await call("PATCH", `/api/users/${admin.user.id}/role`, admin.cookie, { role: "faculty" });
  assert.equal(nowSecond.status, 200, "demoting one of two administrators is allowed");
  assert.equal((await db.prepare("SELECT role FROM users WHERE id = ?").get(faculty.user.id)).role, "admin");

  // The original administrator is now faculty, so the remaining administrator uses their own session.
  const last = await call("PATCH", `/api/users/${faculty.user.id}/role`, faculty.cookie, { role: "student" });
  assert.equal(last.status, 409, "the remaining administrator is protected");
  assert.equal((await db.prepare("SELECT role FROM users WHERE id = ?").get(faculty.user.id)).role, "admin");
});
