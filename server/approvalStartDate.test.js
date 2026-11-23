// SCRUM-43: a pending request whose start date has passed (Cambodia time) cannot be approved, only rejected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { todayISO } from "./rules.js";

const GOOD = "goodpass1";
const PASSED = "The start date has passed. Reject this request so the student can send a new one.";
const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Runs the rest of the test as if the server were in `zone`. Assigning, not deleting, resets Node's cached zone.
function useZone(t, zone) {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => {
    process.env.TZ = saved || hostZone;
  });
}

// The admin signs up on the real clock, so the mocked times below (all earlier) still fall inside the session.
async function start(t) {
  const db = openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const signup = await fetch(`${root}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ly.sophea@cadt.edu.kh", password: GOOD }),
  });
  assert.equal(signup.status, 201);
  const adminId = (await signup.json()).user.id;
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminId);
  const cookie = signup.headers.get("set-cookie").split(";")[0];

  const studentId = Number(
    db
      .prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES ('meas.rithy@student.cadt.edu.kh', 'Meas Rithy', 'student', 'x')")
      .run().lastInsertRowid,
  );
  const equipmentId = Number(db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Epson projector', 'Projector', 2)").run().lastInsertRowid);
  // Requests are written straight to the table: the student form would refuse a past borrow date.
  const pending = (borrowDate) =>
    Number(
      db
        .prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date) VALUES (?, ?, ?, date(?, '+7 days'))")
        .run(equipmentId, studentId, borrowDate, borrowDate).lastInsertRowid,
    );
  const post = async (path, body = {}) => {
    const res = await fetch(`${root}/api/admin/borrow-requests${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const row = (id) => ({ ...db.prepare("SELECT status, return_date, decided_by FROM borrow_requests WHERE id = ?").get(id) });
  const available = () => db.prepare("SELECT available FROM equipment WHERE id = ?").get(equipmentId).available;
  const notices = () => db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n;
  return { pending, post, row, available, notices };
}

test("a request that started yesterday is refused and nothing changes", async (t) => {
  const h = await start(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-10T05:00:00Z") }); // noon in Phnom Penh
  const id = h.pending("2026-11-09");

  const refused = await h.post(`/${id}/approve`);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: PASSED });
  assert.deepEqual(h.row(id), { status: "pending", return_date: "2026-11-16", decided_by: null });
  assert.equal(h.available(), 2);
  assert.equal(h.notices(), 0);
});

test("a request that starts today is still approved, with the due date counted from the start date", async (t) => {
  const h = await start(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-10T05:00:00Z") });
  const id = h.pending("2026-11-10");

  const approved = await h.post(`/${id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.request.status, "approved");
  assert.equal(approved.body.request.returnDate, "2026-11-17");
  assert.equal(h.available(), 1);
});

test("the day turns at midnight in Phnom Penh even when the server runs in UTC", async (t) => {
  useZone(t, "UTC");
  const h = await start(t);
  const before = h.pending("2026-11-09");
  const after = h.pending("2026-11-09");

  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-09T16:59:59Z") }); // 23:59:59 on Nov 9 in Phnom Penh
  assert.equal(todayISO(), "2026-11-09");
  assert.equal((await h.post(`/${before}/approve`)).status, 200);

  t.mock.timers.setTime(new Date("2026-11-09T17:00:00Z").getTime()); // 00:00 on Nov 10 in Phnom Penh, still Nov 9 in UTC
  assert.equal(todayISO(), "2026-11-10");
  const refused = await h.post(`/${after}/approve`);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: PASSED });
  assert.equal(h.row(after).status, "pending");
});

test("a request whose start date passed can still be rejected, so the student can ask again", async (t) => {
  const h = await start(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T05:00:00Z") });
  const id = h.pending("2026-11-12");

  const rejected = await h.post(`/${id}/reject`, { reason: "The start date passed before anyone reviewed it." });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.request.status, "rejected");
  assert.equal(h.available(), 2);
});

// The admin page is bundled with a tiny fake React (the same approach as users.ui.test.js) and its tree is inspected.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pageModule;
async function loadPage() {
  if (pageModule) return pageModule;
  const virtual = {
    react: `export const useCallback = (f) => f;
      export const useEffect = () => {};
      export const useState = (v) => {
        const slot = globalThis.__A.slot++;
        if (!(slot in globalThis.__A.state)) globalThis.__A.state[slot] = v;
        return [globalThis.__A.state[slot], () => {}];
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
    entryPoints: [join(ROOT, "src/pages/AdminBorrowRequests.jsx")],
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
          for (const source of Object.keys(fakes)) {
            b.onResolve({ filter: new RegExp(source) }, () => ({ path: source, namespace: "v" }));
          }
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

const request = (id, borrowDate) => ({
  id,
  equipmentName: "Epson projector",
  equipmentAssetId: "CG-0001",
  requesterName: "Meas Rithy",
  requesterRole: "student",
  borrowDate,
  returnDate: "2026-11-17",
  purpose: "Class talk",
  status: "pending",
  stock: 2,
});

// useState order in AdminBorrowRequests: 0 status, 1 data, 2 loading, 3 error, 4 toast, 5 review, 6 stage.
function render(page, requests, review = null) {
  globalThis.__A = {
    slot: 0,
    state: { 1: { requests, counts: { pending: requests.length, approved: 0, rejected: 0, cancelled: 0 }, today: todayISO() }, 2: false, 5: review },
  };
  return page.default();
}

test("the admin page marks a passed request and offers only Reject, in the row and in the review panel", async (t) => {
  const page = await loadPage();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-10T05:00:00Z") });
  const passed = request(1, "2026-11-09");
  const current = request(2, "2026-11-10");

  const rows = [...walk(render(page, [passed, current]))].filter((n) => n.type === "tr").slice(1);
  assert.equal(rows.length, 2);
  assert.match(text(rows[0]), /Start date passed/);
  assert.deepEqual(buttons(rows[0]), ["Reject"]);
  assert.doesNotMatch(text(rows[1]), /Start date passed/);
  assert.deepEqual(buttons(rows[1]), ["Reject", "Approve"]);

  const panelPassed = render(page, [passed], passed);
  assert.match(text(panelPassed), /Start date passed\. Reject this request so the student can send a new one\./);
  assert.ok(!buttons(panelPassed).includes("Approve request"));
  const panelCurrent = render(page, [current], current);
  assert.ok(buttons(panelCurrent).includes("Approve request"));
});
