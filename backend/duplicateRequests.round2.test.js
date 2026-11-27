// SCRUM-46 round 2: stale pending requests, an item edited to zero stock, a string equipmentId, and the alert link in the UI.
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
const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function start(t) {
  const db = await openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
    return db.close();
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, cookie, body) => {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json() };
  };
  const signup = async (email) => {
    const res = await fetch(`${root}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: GOOD }),
    });
    assert.equal(res.status, 201);
    return { id: (await res.json()).user.id, cookie: res.headers.get("set-cookie").split(";")[0] };
  };
  const admin = await signup("tep.vanthy@cadt.edu.kh");
  await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  const item = async (name, quantity = 3) =>
    Number((await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Camera', ?) RETURNING id").run(name, quantity)).lastInsertRowid);
  const ask = (user, equipmentId, borrowDate) =>
    call("POST", "/api/borrow-requests", user.cookie, { equipmentId, borrowDate, purpose: "Studio shoot" });
  const adminDo = (id, action, body) => call("POST", `/api/admin/borrow-requests/${id}/${action}`, admin.cookie, body);
  const edit = (id, name, quantity) => call("PUT", `/api/equipment/${id}`, admin.cookie, { name, category: "Camera", quantity });
  return { db, call, signup, item, ask, adminDo, edit };
}

test("a pending request whose start date has passed gets the stale wording, cannot be approved, and cancelling it frees the item", async (t) => {
  const h = await start(t);
  const student = await h.signup("keo.sambath@student.cadt.edu.kh");
  const camera = await h.item("Fujifilm X-T30 Camera");
  const old = addDaysISO(todayISO(), -3);
  const staleId = Number(
    (await h.db
      .prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, status) VALUES (?, ?, ?, ?, 'pending') RETURNING id")
      .run(camera, student.id, old, addDaysISO(old, 7))).lastInsertRowid,
  );
  const day = addDaysISO(todayISO(), 1);

  const refused = await h.ask(student, camera, day);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, {
    error: `You already have a pending request for Fujifilm X-T30 Camera starting ${old}. Its start date has passed, so cancel it in My requests and send a new one.`,
    existingRequestId: staleId,
  });
  assert.equal((await h.adminDo(staleId, "approve")).status, 409, "an admin cannot approve it either");

  assert.equal((await h.call("POST", `/api/borrow-requests/${staleId}/cancel`, student.cookie, {})).status, 200);
  assert.equal((await h.ask(student, camera, day)).status, 201);
});

test("an item an admin edits to quantity 0 still names the pending request (409, not 400); editing back and rejecting frees it", async (t) => {
  const h = await start(t);
  const student = await h.signup("lim.chanra@student.cadt.edu.kh");
  const mic = await h.item("Rode NT1 Microphone", 1);
  const day = addDaysISO(todayISO(), 2);
  const first = await h.ask(student, mic, day);
  assert.equal(first.status, 201);

  assert.equal((await h.edit(mic, "Rode NT1 Microphone", 0)).status, 200);
  const refused = await h.ask(student, mic, day);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.existingRequestId, first.body.request.id);
  assert.ok(refused.body.error.includes("Rode NT1 Microphone"));

  assert.equal((await h.edit(mic, "Rode NT1 Microphone", 1)).status, 200);
  assert.equal((await h.adminDo(first.body.request.id, "reject", { reason: "Reserved for the lab." })).status, 200);
  assert.equal((await h.ask(student, mic, day)).status, 201);
});

test("equipmentId sent as a numeric string still hits the duplicate check", async (t) => {
  const h = await start(t);
  const student = await h.signup("phan.rithisak@student.cadt.edu.kh");
  const lamp = await h.item("LED panel light");
  const day = addDaysISO(todayISO(), 1);
  const first = await h.ask(student, lamp, day);
  assert.equal(first.status, 201);

  const again = await h.ask(student, String(lamp), day);
  assert.equal(again.status, 409);
  assert.equal(again.body.existingRequestId, first.body.request.id);
});

// BorrowRequestNew bundled with a fake React: real state, and a useMemo that caches by deps like the real one.
async function loadRequestPage() {
  const virtual = {
    react: `export const useEffect = () => {};
      export const useId = () => "id";
      export const useState = (v) => {
        const U = globalThis.__U, slot = U.slot++;
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
    "requests-api": "export const createBorrowRequest = async () => { throw globalThis.__U.failure; };",
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

test("the request page shows a View my requests link inside the alert only for a duplicate, and keeps the alert content stable while typing", async () => {
  const page = await loadRequestPage();
  const draw = () => {
    globalThis.__U.slot = 0;
    globalThis.__U.memoSlot = 0;
    return page.default({});
  };
  const find = (tree, type) => [...walk(tree)].find((n) => n.type === type);
  const alertChildren = (tree) => find(tree, "ErrorText").props.children;
  const submit = async (failure) => {
    globalThis.__U.failure = failure;
    await find(draw(), "form").props.onSubmit({ preventDefault() {} });
    return draw();
  };
  // state slots: item, loading, loadError, borrowDate, purpose, error, fields, busy, existingRequestId
  globalThis.__U = {
    state: { 0: asCard({ id: 2, name: "Rode mic", category: "Audio", quantity: 2, available: 1 }), 1: false, 3: addDaysISO(todayISO(), 1) },
    memo: [],
    slot: 0,
    memoSlot: 0,
  };

  // The same message first as a plain 400, then as a 409: a memo keyed on the message alone would keep the old content.
  const SAME = "Something about this request.";
  let tree = await submit(Object.assign(new Error(SAME), { status: 400 }));
  assert.equal(alertChildren(tree), SAME);
  assert.equal(find(alertChildren(tree), "Link"), undefined);

  tree = await submit(Object.assign(new Error(SAME), { status: 409, existingRequestId: 5 }));
  const shown = alertChildren(tree);
  const link = find(shown, "Link");
  assert.equal(link.props.to, "/requests");
  assert.equal([...walk(link.props.children)].join(""), "View my requests");
  assert.ok([...walk(shown)].includes(SAME));

  // Typing re-renders the page; the alert content must stay the same object so ErrorText does not refocus.
  globalThis.__U.state[4] = "Need it for a shoot";
  assert.equal(alertChildren(draw()), shown);

  tree = await submit(Object.assign(new Error("Please fix the fields below."), { status: 400, fields: { borrowDate: "Pick a later date." } }));
  assert.equal(alertChildren(tree), "Please fix the fields below.");
  assert.equal(find(alertChildren(tree), "Link"), undefined, "the link is gone after a plain 400");
});
