import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { addDaysISO, todayISO } from "./rules.js";
import { asCard } from "../src/equipment/cards.js";

const GOOD = "goodpass1";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function start(t, studentCount) {
  const db = openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, cookie, body) => {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
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
  const { id: adminId, cookie: admin } = await signup("meas.sophea@cadt.edu.kh");
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminId);
  const students = [];
  for (let i = 1; i <= studentCount; i += 1) students.push((await signup(`chea.vanna${i}@student.cadt.edu.kh`)).cookie);

  const item = async (quantity, name) =>
    (await call("POST", "/api/equipment", admin, { name, category: "Audio", quantity })).body.equipment.id;
  const edit = (id, quantity, name) => call("PUT", `/api/equipment/${id}`, admin, { name, category: "Audio", quantity });
  const ask = async (student, equipmentId) => {
    const res = await call("POST", "/api/borrow-requests", students[student], {
      equipmentId,
      borrowDate: addDaysISO(todayISO(), 3),
      purpose: "Radio club recording",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.request.id;
  };
  const act = (verb, id, body) => call("POST", `/api/admin/borrow-requests/${id}/${verb}`, admin, body);
  const row = (id) => ({ ...db.prepare("SELECT quantity, available FROM equipment WHERE id = ?").get(id) });
  return { db, call, admin, item, edit, ask, act, row };
}

test("an edit heals a shelf that drifted high or low, and the healed shelf then gates approvals", async (t) => {
  const h = await start(t, 4);
  const id = await h.item(3, "Zoom recorder");
  assert.equal((await h.act("approve", await h.ask(0, id))).status, 200);

  h.db.prepare("UPDATE equipment SET available = 3 WHERE id = ?").run(id); // a loan is out, yet the shelf reads full
  assert.equal((await h.edit(id, 3, "Zoom H5 recorder")).status, 200);
  assert.deepEqual(h.row(id), { quantity: 3, available: 2 });

  h.db.prepare("UPDATE equipment SET available = 0 WHERE id = ?").run(id); // the shelf reads empty with 2 on it
  assert.equal((await h.edit(id, 3, "Zoom H5 recorder")).status, 200);
  assert.deepEqual(h.row(id), { quantity: 3, available: 2 });

  const more = [await h.ask(1, id), await h.ask(2, id), await h.ask(3, id)];
  assert.equal((await h.act("approve", more[0])).status, 200);
  assert.equal((await h.act("approve", more[1])).status, 200);
  assert.equal((await h.act("approve", more[2])).status, 409, "never more loans than the total");
  assert.deepEqual(h.row(id), { quantity: 3, available: 0 });
});

test("the on-loan floor counts only this item's approved loans, not pending, returned, cancelled, rejected or other items", async (t) => {
  const h = await start(t, 7);
  const other = await h.item(2, "Rode mic");
  for (const s of [0, 1]) assert.equal((await h.act("approve", await h.ask(s, other))).status, 200);

  const id = await h.item(5, "Shure mic");
  assert.equal((await h.act("approve", await h.ask(2, id))).status, 200); // still out
  const back = await h.ask(3, id);
  assert.equal((await h.act("approve", back)).status, 200);
  assert.equal((await h.act("return", back)).status, 200);
  const called = await h.ask(4, id);
  assert.equal((await h.act("approve", called)).status, 200);
  assert.equal((await h.act("cancel", called, { reason: "Wrong item" })).status, 200);
  assert.equal((await h.act("reject", await h.ask(5, id), { reason: "Booked" })).status, 200);
  await h.ask(6, id); // pending: reserves nothing
  assert.deepEqual(h.row(id), { quantity: 5, available: 4 });

  assert.equal((await h.edit(id, 1, "Shure mic")).status, 200);
  assert.deepEqual(h.row(id), { quantity: 1, available: 0 });
  const zero = await h.edit(id, 0, "Shure mic");
  assert.equal(zero.status, 400);
  assert.equal(zero.body.fields.quantity, "Total cannot be lower than the 1 item on loan.");
  assert.deepEqual(h.row(other), { quantity: 2, available: 0 }, "the other item is untouched");
});

test("the startup repair fills only NULL shelves, floors at 0, and leaves a non-NULL shelf alone", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scrum41-r3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "app.db");
  const first = openDb(path);
  first.exec(`
    INSERT INTO users (id, email, full_name, role, password_hash) VALUES (1, 'sok.dara@student.cadt.edu.kh', 'Sok Dara', 'student', 'x');
    INSERT INTO equipment (id, name, category, quantity) VALUES (1, 'A', 'Audio', 2), (2, 'B', 'Audio', 1), (3, 'C', 'Audio', 4), (4, 'D', 'Audio', 0);
    INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, status) VALUES
      (1, 1, '2026-11-01', '2026-11-08', 'approved'), (1, 1, '2026-11-01', '2026-11-08', 'returned'),
      (1, 1, '2026-11-01', '2026-11-08', 'pending'), (1, 1, '2026-11-01', '2026-11-08', 'cancelled'),
      (2, 1, '2026-11-01', '2026-11-08', 'approved'), (2, 1, '2026-11-01', '2026-11-08', 'approved'),
      (2, 1, '2026-11-01', '2026-11-08', 'approved');
    UPDATE equipment SET available = NULL WHERE id IN (1, 2, 4);
    UPDATE equipment SET available = 1 WHERE id = 3;
  `);
  first.close();

  const expected = [
    { id: 1, quantity: 2, available: 1 },
    { id: 2, quantity: 1, available: 0 },
    { id: 3, quantity: 4, available: 1 },
    { id: 4, quantity: 0, available: 0 },
  ];
  for (let open = 0; open < 2; open += 1) {
    const db = openDb(path);
    try {
      assert.deepEqual(db.prepare("SELECT id, quantity, available FROM equipment ORDER BY id").all().map((r) => ({ ...r })), expected);
    } finally {
      db.close();
    }
  }
  const raw = new DatabaseSync(path);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM equipment WHERE available IS NULL").get().n, 0);
  raw.close();
});

test("the admin request list reports the live shelf and total after approvals, an edit and a return", async (t) => {
  const h = await start(t, 3);
  const id = await h.item(2, "JBL speaker");
  const out = await h.ask(0, id);
  assert.equal((await h.act("approve", out)).status, 200);
  await h.ask(1, id);
  assert.equal((await h.edit(id, 5, "JBL speaker")).status, 200);

  const view = async (status) => (await h.call("GET", `/api/admin/borrow-requests?status=${status}`, h.admin)).body.requests;
  const [pending] = await view("pending");
  assert.deepEqual({ stock: pending.stock, total: pending.total }, { stock: 4, total: 5 });
  assert.equal((await h.act("return", out)).status, 200);
  const [again] = await view("pending");
  assert.deepEqual({ stock: again.stock, total: again.total }, { stock: 5, total: 5 });
});

// Pages bundled with a fake React whose setters really store state, so a save can be replayed.
async function loadPage(entry, fakes) {
  const virtual = {
    react: `export const useEffect = () => {};
      export const useMemo = (f) => f();
      export const useCallback = (f) => f;
      export const useId = () => "id" + globalThis.__U.slot;
      export const useState = (v) => {
        const U = globalThis.__U, slot = U.slot++;
        if (!(slot in U.state)) U.state[slot] = v;
        return [U.state[slot], (next) => { U.state[slot] = typeof next === "function" ? next(U.state[slot]) : next; }];
      };`,
    "react-dom": "export const flushSync = (f) => f();",
    "fake/jsx-runtime": `export const jsx = (type, props, key) => ({ type, props, key }); export const jsxs = jsx; export const Fragment = "f";`,
  };
  const result = await build({
    entryPoints: [join(ROOT, entry)],
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
          b.onResolve({ filter: /^react$|^react-dom$|^fake\/jsx-runtime$/ }, (a) => ({ path: a.path, namespace: "v" }));
          for (const source of Object.keys(fakes)) b.onResolve({ filter: new RegExp(source) }, () => ({ path: source, namespace: "v" }));
          b.onLoad({ filter: /.*/, namespace: "v" }, (a) => ({ contents: virtual[a.path] ?? fakes[a.path], loader: "js" }));
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
const draw = (page, props) => {
  globalThis.__U.slot = 0;
  return page.default(props);
};
const quantityHint = (tree) => [...walk(tree)].find((n) => n.props?.label === "Total quantity")?.props.hint;
const AUTH_UI = "export const AuthShell = 0, Field = 0, SelectField = 0, ErrorText = 0, SuccessText = 0;";

test("the edit page, the drawer and the request pill show stock from the item, and the edit hint follows a save", async () => {
  const edit = await loadPage("src/pages/EquipmentEdit.jsx", {
    "react-router-dom$": `export const Link = 0; export const useParams = () => ({ id: "7" });`,
    "auth/AuthUI[.]jsx$": AUTH_UI,
    "equipment/api[.]js$": "export const getEquipment = 0; export const updateEquipment = async () => globalThis.__U.saved;",
  });
  // slots: loaded, name, category, quantity, onLoan
  globalThis.__U = { state: { 0: true, 1: "Shure mic", 2: "Audio", 3: "3", 4: 2 }, saved: { name: "Shure mic", quantity: 5, available: 5 } };
  let tree = draw(edit, {});
  assert.equal(quantityHint(tree), "2 on loan. Total must be 2 or more.");
  const form = [...walk(tree)].find((n) => n.type === "form");
  await form.props.onSubmit({ preventDefault() {} });
  tree = draw(edit, {});
  assert.equal(quantityHint(tree), "Quantity must be 0 or more.", "the hint uses the saved item, not the loaded one");

  const drawer = await loadPage("src/components/equipment/EquipmentDrawer.jsx", {
    "auth/AuthUI[.]jsx$": AUTH_UI,
    "Icons[.]jsx$": "export const CloseIcon = 0;",
  });
  const item = { id: 1, name: "Shure mic", category: "Audio", quantity: 4, available: 1 };
  globalThis.__U = { state: {} };
  assert.equal(quantityHint(draw(drawer, { mode: "edit", item, onClose() {}, onSave() {} })), "3 on loan. Total must be 3 or more.");
  globalThis.__U = { state: {} };
  assert.equal(quantityHint(draw(drawer, { mode: "add", item, onClose() {}, onSave() {} })), "Quantity must be 0 or more.");

  const request = await loadPage("src/pages/BorrowRequestNew.jsx", {
    "react-router-dom$": `export const Link = 0; export const useNavigate = () => () => {}; export const useSearchParams = () => [new URLSearchParams("equipmentId=2")];`,
    "components/StudentHeader[.]jsx$": "export default 0;",
    "equipment/api[.]js$": "export const getEquipment = 0;",
    "borrowRequests/api[.]js$": "export const createBorrowRequest = 0;",
    "auth/AuthUI[.]jsx$": "export const ErrorText = 0;",
  });
  // slots: item, loading
  globalThis.__U = { state: { 0: asCard({ id: 2, name: "Rode mic", category: "Audio", quantity: 2, available: 0 }), 1: false } };
  const pill = [...walk(draw(request, {}))].find((n) => String(n.props?.className).startsWith("availability-pill"));
  assert.equal(pill.props.className, "availability-pill out-stock");
  assert.equal([...walk(pill.props.children)].join(""), "0 of 2 available");
});

test("after a refused save the edit page refreshes its on-loan hint and the drawer hides its hint beside the error", async () => {
  const edit = await loadPage("src/pages/EquipmentEdit.jsx", {
    "react-router-dom$": `export const Link = 0; export const useParams = () => ({ id: "7" });`,
    "auth/AuthUI[.]jsx$": AUTH_UI,
    "equipment/api[.]js$": `export const getEquipment = async () => globalThis.__U.fresh;
      export const updateEquipment = async () => { throw Object.assign(new Error("Please fix the fields below."), { status: 400, fields: { quantity: "Total cannot be lower than the 3 items on loan." } }); };`,
  });
  globalThis.__U = { state: { 0: true, 1: "Shure mic", 2: "Audio", 3: "1", 4: 1 }, fresh: { quantity: 4, available: 1 } };
  assert.equal(quantityHint(draw(edit, {})), "1 on loan. Total must be 1 or more.");
  const form = [...walk(draw(edit, {}))].find((n) => n.type === "form");
  await form.props.onSubmit({ preventDefault() {} });
  const tree = draw(edit, {});
  const field = [...walk(tree)].find((n) => n.props?.label === "Total quantity").props;
  assert.equal(field.error, "Total cannot be lower than the 3 items on loan.");
  assert.equal(field.hint, "3 on loan. Total must be 3 or more.", "the hint now agrees with the server");

  const drawer = await loadPage("src/components/equipment/EquipmentDrawer.jsx", {
    "auth/AuthUI[.]jsx$": AUTH_UI,
    "Icons[.]jsx$": "export const CloseIcon = 0;",
  });
  const item = { id: 1, name: "Shure mic", category: "Audio", quantity: 4, available: 1 };
  // slots: name, category, quantity, fields
  globalThis.__U = { state: { 3: { quantity: "Total cannot be lower than the 3 items on loan." } } };
  assert.equal(quantityHint(draw(drawer, { mode: "edit", item, onClose() {}, onSave() {} })), undefined);
});
