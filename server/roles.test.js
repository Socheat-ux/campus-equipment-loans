import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { requireRole } from "./auth.js";
import { access, rolesLabel } from "../src/auth/access.js";

const GOOD = "goodpass1";

// Every API route and who may reach it. "public": anyone; "signed-in": any role; "admin": administrators only.
// A new route must be added here, or the count check below fails.
const ROUTES = [
  ["POST", "/api/auth/signup", "public"],
  ["POST", "/api/auth/login", "public"],
  ["POST", "/api/auth/logout", "public"],
  ["GET", "/api/auth/me", "signed-in"],
  ["GET", "/api/equipment", "public"],
  ["GET", "/api/equipment/1", "public"],
  ["POST", "/api/equipment", "admin"],
  ["PUT", "/api/equipment/1", "admin"],
  ["GET", "/api/notifications", "signed-in"],
  ["POST", "/api/notifications/read", "signed-in"],
];

// Counts endpoints: route handlers (one per path and method, so array paths count each path) inside mounted routers,
// plus app-level routes and path-mounted middleware or sub-apps under /api. Not counted: path-less middleware, the
// final "/api" 404 handler and the built site's catch-all. Express 4 hides a mounted sub-app behind a wrapper, so it counts as one.
function countRouterRoutes(stack, nested = false) {
  return stack.reduce((sum, layer) => {
    if (layer.route) {
      const paths = [].concat(layer.route.path).filter((p) => nested || (typeof p === "string" && p.startsWith("/api")));
      return sum + paths.length * Object.keys(layer.route.methods).length;
    }
    const inner = layer.handle.stack ?? layer.handle._router?.stack; // a router, or an app with its own router
    if (inner) return sum + countRouterRoutes(inner, true);
    // Express writes app.use("/api/x", fn) as the regexp ^\/api\/x...; the 404 handler's is ^\/api\/?... instead.
    const mounted = !layer.regexp.fast_slash && (nested || /^\^\\\/api\\\/(?!\?)/.test(layer.regexp.source));
    return sum + (mounted ? 1 : 0);
  }, 0);
}

async function start(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  return (method, path, cookie, body = method === "GET" ? undefined : {}) =>
    fetch(`${root}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

test("every API route is listed, and each one lets in exactly the roles it should", async (t) => {
  const db = openDb(":memory:");
  const app = createApp(db);
  assert.equal(countRouterRoutes(app._router.stack), ROUTES.length, "an API route was added or removed: update ROUTES");

  const call = await start(t, app);
  const signup = async (email) => {
    const res = await call("POST", "/api/auth/signup", undefined, { email, password: GOOD });
    assert.equal(res.status, 201, email);
    return res.headers.get("set-cookie").split(";")[0];
  };
  const cookies = {
    guest: undefined,
    student: await signup("sok.dara@student.cadt.edu.kh"),
    faculty: await signup("keo.bopha@cadt.edu.kh"),
    admin: await signup("chan.nita@cadt.edu.kh"),
  };
  db.prepare("UPDATE users SET role = 'admin' WHERE email = 'chan.nita@cadt.edu.kh'").run();
  db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Projector', 'Projector', 1)").run();

  const expected = {
    public: { guest: "in", student: "in", faculty: "in", admin: "in" },
    "signed-in": { guest: 401, student: "in", faculty: "in", admin: "in" },
    admin: { guest: 401, student: 403, faculty: 403, admin: "in" },
  };
  for (const [method, path, rule] of ROUTES) {
    if (path === "/api/auth/logout") continue; // logging out would end the sessions the other checks use
    for (const [who, cookie] of Object.entries(cookies)) {
      const { status } = await call(method, path, cookie);
      const want = expected[rule][who];
      const label = `${method} ${path} as ${who} gave ${status}`;
      assert.notEqual(status, 404, label); // a misspelt row would otherwise pass as "in"
      if (want === "in") assert.ok(status !== 401 && status !== 403, label);
      else assert.equal(status, want, label);
    }
  }
});

test("requireRole refuses misspelt roles at startup and lets several roles share a route", async (t) => {
  const db = openDb(":memory:");
  for (const bad of [[], ["Admin"], ["admin", "staff"], [undefined]]) {
    assert.throws(() => requireRole(db, ...bad), /requireRole needs/, JSON.stringify(bad));
  }

  const app = createApp(db);
  const people = express.Router();
  people.get("/", requireRole(db, "student", "faculty"), (req, res) => res.json({ role: req.user.role }));
  const outer = express();
  outer.use("/people", people);
  outer.use(app);
  const call = await start(t, outer);
  const signup = async (email) =>
    (await call("POST", "/api/auth/signup", undefined, { email, password: GOOD })).headers.get("set-cookie").split(";")[0];
  const student = await signup("sok.dara@student.cadt.edu.kh");
  const admin = await signup("chan.nita@cadt.edu.kh");
  db.prepare("UPDATE users SET role = 'admin' WHERE email = 'chan.nita@cadt.edu.kh'").run();

  const asStudent = await call("GET", "/people", student);
  assert.equal(asStudent.status, 200);
  assert.deepEqual(await asStudent.json(), { role: "student" });
  const asAdmin = await call("GET", "/people", admin);
  assert.equal(asAdmin.status, 403);
  assert.deepEqual(await asAdmin.json(), { error: "You do not have access to this." });
  assert.equal((await call("GET", "/people")).status, 401);
  // The admin-only message stays specific.
  const studentWrite = await call("POST", "/api/equipment", student, { name: "x", category: "Lab", quantity: 1 });
  assert.deepEqual(await studentWrite.json(), { error: "Administrators only." });
});

test("access() decides login, denied or ok, and refuses unknown roles", () => {
  const admin = { role: "admin" };
  const student = { role: "student" };
  assert.equal(access(null, ["admin"]), "login");
  assert.equal(access(undefined, ["student", "faculty"]), "login");
  assert.equal(access(student, ["admin"]), "denied");
  assert.equal(access({ role: "faculty" }, ["admin"]), "denied");
  assert.equal(access(admin, ["admin"]), "ok");
  assert.equal(access(student, ["student", "faculty"]), "ok");
  assert.equal(access({ role: "staff" }, ["student", "faculty", "admin"]), "denied");
  for (const bad of [undefined, [], ["Admin"], "admin"]) assert.throws(() => access(admin, bad), TypeError, JSON.stringify(bad));

  assert.equal(rolesLabel(["admin"]), "administrators");
  assert.equal(rolesLabel(["student", "faculty"]), "students and faculty");
  assert.equal(rolesLabel(["student", "faculty", "admin"]), "students, faculty and administrators");
});
