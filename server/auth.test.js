import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { roleFor, displayName, passwordError } from "./rules.js";

test("email rules pick the role and keep Southeast Asian name order", () => {
  assert.equal(roleFor("hong.bonsak@student.cadt.edu.kh"), "student");
  assert.equal(roleFor("leuker.felix@cadt.edu.kh"), "faculty");
  assert.equal(roleFor("bonsak@student.cadt.edu.kh"), null);
  assert.equal(roleFor("hong.bonsak@gmail.com"), null);
  assert.equal(roleFor("hong.bonsak@student.cadt.edu.kh.evil.com"), null);
  assert.equal(roleFor("hong.bonsak@cadt.edu.kh.evil.com"), null);
  assert.equal(displayName("hong.bonsak@student.cadt.edu.kh"), "Hong Bonsak");
  assert.equal(displayName("chhon.chhaychanvibol2@student.cadt.edu.kh"), "Chhon Chhaychanvibol");
  assert.ok(passwordError("short1"));
  assert.ok(passwordError("onlyletters"));
  assert.equal(passwordError("goodpass1"), null);
});

test("signup, me, logout, login", async (t) => {
  const server = createApp(openDb(":memory:")).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  let cookie = "";
  const call = async (path, body) => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return res;
  };
  const mail = "hong.bonsak@student.cadt.edu.kh";

  assert.equal((await call("/signup", { email: "x@gmail.com", password: "goodpass1" })).status, 400);
  assert.equal((await call("/signup", { email: mail, password: "weak" })).status, 400);

  const created = await call("/signup", { email: mail.toUpperCase(), password: "goodpass1" });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).user, { id: 1, email: mail, fullName: "Hong Bonsak", role: "student" });
  assert.equal((await call("/me")).status, 200);
  assert.equal((await call("/signup", { email: mail, password: "goodpass1" })).status, 409);

  assert.equal((await call("/logout", {})).status, 204);
  assert.equal((await call("/me")).status, 401);

  assert.equal((await call("/login", { email: mail, password: "wrongpass1" })).status, 401);
  assert.equal((await call("/login", { email: "nobody.here@student.cadt.edu.kh", password: "goodpass1" })).status, 401);
  assert.equal((await call("/login", { email: mail, password: "goodpass1" })).status, 200);
  assert.equal((await call("/me")).status, 200);
});
