// SCRUM-47: a student promoted to admin cannot approve their own request; another admin can.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { addDaysISO, todayISO } from "../shared/rules.js";

const GOOD = "goodpass1";
const OWN = "You cannot approve your own request. Another administrator must decide on it.";

async function start(t) {
  const db = await openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await db.close();
  });
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
  return { db, call, signup };
}

test("a student promoted to admin gets 403 on their own request, nothing changes, and another admin can approve it", async (t) => {
  const { db, call, signup } = await start(t);
  const first = await signup("ly.sophea@cadt.edu.kh");
  await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(first.id); // the first admin is set up by hand, as in production
  const student = await signup("meas.rithy@student.cadt.edu.kh");
  const second = await signup("kem.vuthy@cadt.edu.kh");
  const itemId = Number(
    (await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Epson projector', 'Projector', 2) RETURNING id").run()).lastInsertRowid,
  );

  const made = await call("POST", "/api/borrow-requests", student.cookie, { equipmentId: itemId, borrowDate: addDaysISO(todayISO(), 1), purpose: "Club event" });
  assert.equal(made.status, 201);
  const requestId = made.body.request.id;

  // The card's steps: the student is promoted to admin through the Users API.
  for (const user of [student, second]) {
    assert.equal((await call("PATCH", `/api/users/${user.id}/role`, first.cookie, { role: "admin" })).status, 200);
  }
  const noticesBefore = (await db.prepare("SELECT COUNT(*)::int AS n FROM notifications").get()).n;

  const own = await call("POST", `/api/admin/borrow-requests/${requestId}/approve`, student.cookie);
  assert.equal(own.status, 403);
  assert.deepEqual(own.body, { error: OWN });
  assert.deepEqual({ ...(await db.prepare("SELECT status, decided_by FROM borrow_requests WHERE id = ?").get(requestId)) }, { status: "pending", decided_by: null });
  assert.equal((await db.prepare("SELECT available FROM equipment WHERE id = ?").get(itemId)).available, 2);
  assert.equal((await db.prepare("SELECT COUNT(*)::int AS n FROM notifications").get()).n, noticesBefore, "a refused approval sends no notices");

  const list = await call("GET", "/api/admin/borrow-requests", student.cookie);
  assert.equal(list.body.viewerId, student.id, "the page learns who is looking");

  const other = await call("POST", `/api/admin/borrow-requests/${requestId}/approve`, second.cookie);
  assert.equal(other.status, 200);
  assert.equal(other.body.request.status, "approved");
  assert.equal(other.body.request.decidedBy, second.id);
  assert.equal((await db.prepare("SELECT available FROM equipment WHERE id = ?").get(itemId)).available, 1);
});

// The admin page is bundled with a tiny fake React (the pattern from approvalStartDate.test.js) and its tree is inspected.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pageModule;
async function loadPage() {
  if (pageModule) return pageModule;
  const virtual = {
    react: `export const useCallback = (f) => f;
      export const useEffect = () => {};
      export const useState = (v) => {
        const slot = globalThis.__O.slot++;
        if (!(slot in globalThis.__O.state)) globalThis.__O.state[slot] = v;
        return [globalThis.__O.state[slot], () => {}];
      };`,
    "fake/jsx-runtime": `export const jsx = (type, props, key) => ({ type, props, key }); export const jsxs = jsx; export const Fragment = "f";`,
  };
  const fakes = {
    "layouts/DashboardLayout[.]jsx$": "export default ({ children }) => children;",
    "components/equipment/Toast[.]jsx$": "export default () => null;",
    "auth/AuthUI[.]jsx$": "export const ErrorText = ({ children }) => children;",
    "borrowRequests/adminApi[.]js$":
      "export const approveBorrowRequest = 0, cancelBorrowRequestAdmin = 0, listAdminBorrowRequests = 0, rejectBorrowRequest = 0, returnBorrowRequest = 0;",
  };
  const result = await build({
    entryPoints: [join(ROOT, "frontend/src/pages/AdminBorrowRequests.jsx")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    jsx: "automatic",
    jsxImportSource: "fake",
    logLevel: "silent",
    plugins: [
      {
        name: "fakes",
        setup(b) {
          b.onResolve({ filter: /^react$|^fake\/jsx-runtime$/ }, (a) => ({ path: a.path, namespace: "v" }));
          for (const source of Object.keys(fakes)) b.onResolve({ filter: new RegExp(source) }, () => ({ path: source, namespace: "v" }));
          b.onLoad({ filter: /.*/, namespace: "v" }, (a) => ({ contents: virtual[a.path] ?? fakes[a.path], loader: "js" }));
        },
      },
    ],
  });
  pageModule = await import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
  return pageModule;
}

function* walk(node) {
  if (Array.isArray(node)) for (const child of node) yield* walk(child);
  else if (node && typeof node === "object") {
    yield node;
    yield* walk(node.props?.children);
  } else if (node != null) yield node;
}
const text = (node) => [...walk(node)].filter((n) => typeof n === "string" || typeof n === "number").join("");
const buttons = (tree) => [...walk(tree)].filter((n) => n.type === "button").map(text);

const request = (id, userId, requesterName) => ({
  id,
  userId,
  equipmentName: "Epson projector",
  equipmentAssetId: "CG-0001",
  requesterName,
  requesterRole: "student",
  borrowDate: "2026-12-10",
  returnDate: "2026-12-17",
  purpose: "Club event",
  status: "pending",
  stock: 2,
  total: 2,
});

// useState order in AdminBorrowRequests: 0 status, 1 data, 2 loading, 3 error, 4 toast, 5 review.
function render(page, requests, viewerId, review = null) {
  globalThis.__O = {
    slot: 0,
    state: { 1: { requests, counts: { pending: requests.length, approved: 0, rejected: 0, cancelled: 0 }, today: "2026-12-01", viewerId }, 2: false, 5: review },
  };
  return page.default();
}

test("the admin page marks the viewer's own request and offers only Reject there, in the row and in the review panel", async (t) => {
  t.after(() => delete globalThis.__O);
  const page = await loadPage();
  const own = request(1, 7, "Meas Rithy");
  const other = request(2, 8, "Chea Dara");

  const rows = [...walk(render(page, [own, other], 7))].filter((n) => n.type === "tr").slice(1);
  assert.equal(rows.length, 2);
  assert.match(text(rows[0]), /Your own request/);
  assert.deepEqual(buttons(rows[0]), ["Reject"]);
  assert.doesNotMatch(text(rows[1]), /Your own request/);
  assert.deepEqual(buttons(rows[1]), ["Reject", "Approve"]);

  const panelOwn = render(page, [own], 7, own);
  assert.match(text(panelOwn), /This is your own request\. Another administrator must approve it\./);
  assert.ok(!buttons(panelOwn).includes("Approve request"));
  assert.ok(buttons(render(page, [other], 7, other)).includes("Approve request"));

  // Before the list has loaded there is no viewerId, so nothing is marked as the viewer's own.
  assert.deepEqual(buttons([...walk(render(page, [own], undefined))].filter((n) => n.type === "tr")[1]), ["Reject", "Approve"]);
});
