import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { requireRole } from "./auth.js";
import { access, rolesLabel } from "../src/auth/access.js";

const GOOD = "goodpass1";

// Every API route and who may reach it. "public": anyone; "signed-in": any role; "borrower": students and faculty;
// "admin": administrators only. A new route must be added here, or the count check below fails.
const ROUTES = [
  ["POST", "/api/auth/signup", "public"],
  ["POST", "/api/auth/login", "public"],
  ["POST", "/api/auth/logout", "public"],
  ["GET", "/api/auth/me", "signed-in"],
  ["GET", "/api/equipment", "public"],
  ["GET", "/api/equipment/1", "public"],
  ["POST", "/api/equipment", "admin"],
  ["PUT", "/api/equipment/1", "admin"],
  ["DELETE", "/api/equipment/1", "admin"],
  ["GET", "/api/borrow-requests", "borrower"],
  ["GET", "/api/borrow-requests/1", "borrower"],
  ["POST", "/api/borrow-requests", "borrower"],
  ["POST", "/api/borrow-requests/1/cancel", "borrower"],
  ["GET", "/api/admin/borrow-requests", "admin"],
  ["POST", "/api/admin/borrow-requests/1/approve", "admin"],
  ["POST", "/api/admin/borrow-requests/1/reject", "admin"],
  ["POST", "/api/admin/borrow-requests/1/return", "admin"],
  ["POST", "/api/admin/borrow-requests/1/cancel", "admin"],
  ["GET", "/api/admin/overdue", "admin"],
  ["GET", "/api/notifications", "signed-in"],
  ["POST", "/api/notifications/read", "signed-in"],
  ["POST", "/api/notifications/read-all", "signed-in"],
  ["POST", "/api/notifications/1/read", "signed-in"],
  ["GET", "/api/users", "admin"],
  ["PATCH", "/api/users/1/role", "admin"],
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
  const emails = {
    student: "sok.dara@student.cadt.edu.kh",
    faculty: "keo.bopha@cadt.edu.kh",
    admin: "chan.nita@cadt.edu.kh",
  };
  const cookies = {
    guest: undefined,
    student: await signup(emails.student),
    faculty: await signup(emails.faculty),
    admin: await signup(emails.admin),
  };
  db.prepare("UPDATE users SET role = 'admin' WHERE email = 'chan.nita@cadt.edu.kh'").run();
  db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Projector', 'Projector', 1)").run();
  // The detail route answers 404 without a row of the caller's own, which would look like a misspelt route below.
  const seedRequest = (who) => {
    db.prepare("DELETE FROM borrow_requests WHERE id = 1").run();
    db
      .prepare(
        `INSERT INTO borrow_requests (id, equipment_id, user_id, borrow_date, return_date, status)
         VALUES (1, 1, (SELECT id FROM users WHERE role = ?), '2026-01-01', '2026-01-08', 'pending')`,
      )
      .run(who);
  };
  const seeds = {
    "/api/borrow-requests/1": (who) => {
      if (who !== "student" && who !== "faculty") return; // guests and administrators never reach the handler
      seedRequest(who);
    },
    "/api/borrow-requests/1/cancel": (who) => {
      if (who !== "student" && who !== "faculty") return; // guests and administrators never reach the handler
      seedRequest(who);
    },
    "/api/admin/borrow-requests/1/approve": (who) => {
      if (who === "admin") seedRequest("student");
    },
    "/api/admin/borrow-requests/1/reject": (who) => {
      if (who === "admin") seedRequest("student");
    },
    "/api/notifications/1/read": (who) => {
      const email = emails[who];
      if (!email) return;
      db.prepare("DELETE FROM notifications WHERE id = 1").run();
      db
        .prepare(
          `INSERT INTO notifications (id, user_id, type, message)
           VALUES (1, (SELECT id FROM users WHERE email = ?), 'request_approved', 'Seed')`,
        )
        .run(email);
    },
  };

  const expected = {
    public: { guest: "in", student: "in", faculty: "in", admin: "in" },
    "signed-in": { guest: 401, student: "in", faculty: "in", admin: "in" },
    borrower: { guest: 401, student: "in", faculty: "in", admin: 403 },
    admin: { guest: 401, student: 403, faculty: 403, admin: "in" },
  };
  for (const [method, path, rule] of ROUTES) {
    if (path === "/api/auth/logout") continue; // logging out would end the sessions the other checks use
    for (const [who, cookie] of Object.entries(cookies)) {
      seeds[path]?.(who);
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
