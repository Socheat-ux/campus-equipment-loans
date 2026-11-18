import { test } from "node:test";
import assert from "node:assert/strict";
import { listUsers, setUserRole } from "../src/users/api.js";

// The browser helpers are plain modules, so they can be checked in Node with a stubbed fetch and window.
async function withFetch(t, handler) {
  const realFetch = globalThis.fetch;
  const realWindow = globalThis.window;
  const events = [];
  globalThis.fetch = handler;
  globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
  t.after(() => {
    globalThis.fetch = realFetch;
    globalThis.window = realWindow;
  });
  return events;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("the client lists users and sends role changes as JSON PATCH to the right URL", async (t) => {
  const calls = [];
  await withFetch(t, async (url, init) => {
    calls.push({ url, init });
    return json(200, url === "/api/users" ? { users: [{ id: 1 }] } : { user: { id: 7, role: "admin" } });
  });

  assert.deepEqual(await listUsers(), [{ id: 1 }]);
  assert.equal(calls[0].url, "/api/users");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);

  assert.deepEqual(await setUserRole(7, "admin"), { id: 7, role: "admin" });
  assert.equal(calls[1].url, "/api/users/7/role");
  assert.equal(calls[1].init.method, "PATCH");
  assert.equal(calls[1].init.body, '{"role":"admin"}');
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");

  await setUserRole("a/b", "student");
  assert.equal(calls[2].url, "/api/users/a%2Fb/role", "ids are encoded into the path");
});

test("the client maps errors and refreshes the session when a role changed underneath it", async (t) => {
  const events = await withFetch(t, async (url) => {
    if (url === "/api/users/1/role") return json(403, { error: "Administrators only." });
    if (url === "/api/users") return json(401, { error: "Please log in." });
    return json(400, { error: "Please choose a valid role.", fields: { role: "Choose one of: student, faculty, admin." } });
  });

  await assert.rejects(() => setUserRole(1, "admin"), (err) => {
    assert.equal(err.status, 403);
    assert.equal(err.message, "Administrators only.");
    return true;
  });
  await assert.rejects(() => listUsers(), (err) => err.status === 401);
  await assert.rejects(() => setUserRole(2, "staff"), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.fields.role, /student, faculty, admin/);
    return true;
  });
  assert.deepEqual(events, ["auth-changed", "auth-expired"], "only a 403 refreshes the role; a 401 signs out");
});

test("network failures and non-JSON errors still give the page a message", async (t) => {
  await withFetch(t, async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(() => listUsers(), (err) => err.status === 0 && /Cannot reach the server/.test(err.message));
});
