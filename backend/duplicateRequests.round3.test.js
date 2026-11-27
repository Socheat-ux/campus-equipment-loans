// SCRUM-46 round 3: the today boundary, the real client against the real server, and the link reset on a browser-side failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { addDaysISO, todayISO } from "../shared/rules.js";
import { asCard } from "../frontend/src/equipment/cards.js";

const GOOD = "goodpass1";
const realFetch = globalThis.fetch; // the helpers below keep using this after a test stubs globalThis.fetch
const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function start(t) {
  const db = await openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
    return db.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, cookie, body) => {
    const res = await realFetch(`${origin}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json() };
  };
  const signup = async (email) => {
    const res = await realFetch(`${origin}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: GOOD }),
    });
    assert.equal(res.status, 201);
    return { id: (await res.json()).user.id, cookie: res.headers.get("set-cookie").split(";")[0] };
  };
  const admin = await signup("chea.dara@cadt.edu.kh");
  await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  const item = async (name, quantity = 3) =>
    Number((await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Camera', ?) RETURNING id").run(name, quantity)).lastInsertRowid);
  const ask = (user, equipmentId, borrowDate) =>
    call("POST", "/api/borrow-requests", user.cookie, { equipmentId, borrowDate, purpose: "Studio shoot" });
  const adminDo = (id, action) => call("POST", `/api/admin/borrow-requests/${id}/${action}`, admin.cookie, {});
  return { db, origin, signup, item, ask, adminDo };
}

test("a request starting today: the stale wording appears exactly when approving it is refused, even if midnight passes mid-test", async (t) => {
  const h = await start(t);
  const student = await h.signup("sok.vireak@student.cadt.edu.kh");
  const tripod = await h.item("Manfrotto Tripod");
  const today = todayISO(); // computed once; the server may roll over to the next day during the test
  const firstId = Number(
    (await h.db
      .prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, status) VALUES (?, ?, ?, ?, 'pending') RETURNING id")
      .run(tripod, student.id, today, addDaysISO(today, 7))).lastInsertRowid,
  );

  const refused = await h.ask(student, tripod, addDaysISO(today, 1));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.existingRequestId, firstId);
  const stale = refused.body.error.includes("Its start date has passed");
  assert.equal(stale, !refused.body.error.includes("wait for a decision"), "exactly one of the two wordings");

  const approved = await h.adminDo(firstId, "approve");
  assert.ok([200, 409].includes(approved.status), `unexpected approve status ${approved.status}`);
  assert.equal(stale, approved.status === 409, "stale wording must match whether approval is still possible");
});

test("the real client against the real server keeps existingRequestId and the server message on a duplicate", async (t) => {
  const h = await start(t);
  const student = await h.signup("heng.sophea@student.cadt.edu.kh");
  const gimbal = await h.item("DJI Ronin Gimbal");
  const day = addDaysISO(todayISO(), 2);

  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window");
  globalThis.window = new EventTarget();
  globalThis.fetch = (path, init = {}) =>
    realFetch(`${h.origin}${path}`, { ...init, headers: { ...init.headers, cookie: student.cookie } });
  t.after(() => {
    globalThis.fetch = realFetch;
    if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore);
    else delete globalThis.window;
  });

  const { createBorrowRequest } = await import("../frontend/src/borrowRequests/api.js");
  const first = await createBorrowRequest({ equipmentId: gimbal, borrowDate: day, purpose: "Studio shoot" });
  const serverSays = await h.ask(student, gimbal, day);
  assert.equal(serverSays.status, 409);

  await assert.rejects(createBorrowRequest({ equipmentId: gimbal, borrowDate: day, purpose: "Studio shoot" }), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.existingRequestId, first.id);
    assert.equal(err.message, serverSays.body.error);
    return true;
  });
});

// BorrowRequestNew bundled with a fake React; useState also records each slot's initial value so tests can find slots by it.
async function loadRequestPage() {
  const virtual = {
    react: `export const useEffect = () => {};
      export const useId = () => "id";
      export const useState = (v) => {
        const U = globalThis.__U, slot = U.slot++;
        if (!(slot in U.init)) U.init[slot] = v;
        if (!(slot in U.state)) U.state[slot] = v;
        return [U.state[slot], (next) => { U.state[slot] = typeof next === "function" ? next(U.state[slot]) : next; }];
      };
      export const useMemo = (f, deps) => {
        const U = globalThis.__U, slot = U.memoSlot++, hit = U.memo[slot];
        if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => Object.is(d, deps[i]))) return hit.value;
        const value = f();
        U.memo[slot] = { deps, value };
        return value;
      };`,
    "fake/jsx-runtime": `export const jsx = (type, props, key) => ({ type, props, key }); export const jsxs = jsx; export const Fragment = "f";`,
    "react-router-dom": `export const Link = "Link"; export const useNavigate = () => () => {}; export const useSearchParams = () => [new URLSearchParams("equipmentId=2")];`,
    StudentHeader: `export default "StudentHeader";`,
    "equipment-api": "export const getEquipment = 0;",
    "requests-api": "export const createBorrowRequest = async () => { globalThis.__U.calls++; throw globalThis.__U.failure; };",
    AuthUI: `export const ErrorText = "ErrorText";`,
  };
  const fakeFor = [
    [/components\/StudentHeader[.]jsx$/, "StudentHeader"],
    [/equipment\/api[.]js$/, "equipment-api"],
    [/borrowRequests\/api[.]js$/, "requests-api"],
    [/auth\/AuthUI[.]jsx$/, "AuthUI"],
  ];
  const result = await build({
    entryPoints: [`${ROOT}frontend/src/pages/BorrowRequestNew.jsx`],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    jsx: "automatic",
    jsxImportSource: "fake",
    define: { "import.meta.env.DEV": "false" },
    logLevel: "silent",
    plugins: [
      {
        name: "fakes",
        setup(b) {
          b.onResolve({ filter: /^react$|^fake\/jsx-runtime$|^react-router-dom$/ }, (a) => ({ path: a.path, namespace: "v" }));
          for (const [filter, path] of fakeFor) b.onResolve({ filter }, () => ({ path, namespace: "v" }));
          b.onLoad({ filter: /.*/, namespace: "v" }, (a) => ({ contents: virtual[a.path], loader: "js" }));
        },
      },
    ],
  });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}
function* walk(node) {
  if (Array.isArray(node)) for (const child of node) yield* walk(child);
  else if (node && typeof node === "object") {
    yield node;
    yield* walk(node.props?.children);
  } else if (node != null) yield node;
}

test("the View my requests link disappears when a later submit fails in the browser before reaching the server", async () => {
  const page = await loadRequestPage();
  const draw = () => {
    globalThis.__U.slot = 0;
    globalThis.__U.memoSlot = 0;
    return page.default({});
  };
  const find = (tree, type) => [...walk(tree)].find((n) => n.type === type);
  const alertChildren = (tree) => find(tree, "ErrorText").props.children;
  const submit = async () => {
    await find(draw(), "form").props.onSubmit({ preventDefault() {} });
    return draw();
  };

  globalThis.__U = { state: {}, init: {}, memo: [], slot: 0, memoSlot: 0, calls: 0 };
  draw(); // first render records each slot's initial value
  const { init, state } = globalThis.__U;
  const today = todayISO();
  const itemSlot = Object.keys(init).find((k) => init[k] === null); // first null slot is item; existingRequestId comes later
  const loadingSlot = Object.keys(init).find((k) => init[k] === true);
  const dateSlot = Object.keys(init).find((k) => init[k] === today);
  assert.ok(itemSlot !== undefined && loadingSlot !== undefined && dateSlot !== undefined, "state slots found by initial value");
  state[itemSlot] = asCard({ id: 2, name: "Rode mic", category: "Audio", quantity: 2, available: 1 });
  state[loadingSlot] = false;
  state[dateSlot] = addDaysISO(today, 1);

  globalThis.__U.failure = Object.assign(new Error("You already have a pending request for Rode mic."), { status: 409, existingRequestId: 7 });
  let tree = await submit();
  assert.equal(globalThis.__U.calls, 1);
  assert.ok(find(alertChildren(tree), "Link"), "the 409 shows the link");

  state[dateSlot] = addDaysISO(today, -1);
  tree = await submit();
  assert.equal(globalThis.__U.calls, 1, "a date in the past never reaches the server");
  assert.equal(alertChildren(tree), "Please fix the fields below.");
  assert.equal(find(alertChildren(tree), "Link"), undefined, "the stale link is gone");
});
