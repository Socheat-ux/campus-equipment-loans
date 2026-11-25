// SCRUM-43 round 1: adversarial cases at the Cambodia day boundary, from host zones far from UTC+7.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { processDueReminders } from "./notifications.js";
import { todayISO } from "../shared/rules.js";

const PASSED = "The start date has passed. Reject this request so the student can send a new one.";
const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function useZone(t, zone) {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => {
    process.env.TZ = saved || hostZone;
  });
}

async function start(t, { stock = 2 } = {}) {
  const db = openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const signup = async (email) => {
    const res = await fetch(`${root}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "goodpass1" }),
    });
    assert.equal(res.status, 201);
    return { id: (await res.json()).user.id, cookie: res.headers.get("set-cookie").split(";")[0] };
  };
  const admin = await signup("chea.vanna@cadt.edu.kh");
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  const student = await signup("keo.dara@student.cadt.edu.kh");
  const equipmentId = Number(
    db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Canon camera', 'Camera', ?)").run(stock).lastInsertRowid,
  );
  const call = async (method, path, body, cookie) => {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: { "Content-Type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const insert = (borrowDate, status = "pending") =>
    Number(
      db
        .prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, status) VALUES (?, ?, ?, date(?, '+7 days'), ?)")
        .run(equipmentId, student.id, borrowDate, borrowDate, status).lastInsertRowid,
    );
  const approve = (id) => call("POST", `/api/admin/borrow-requests/${id}/approve`, {}, admin.cookie);
  const available = () => db.prepare("SELECT available FROM equipment WHERE id = ?").get(equipmentId).available;
  return { db, call, insert, approve, available, admin, student, equipmentId };
}

test("with no stock left, a stale request still gets the start-date message, not the stock one", async (t) => {
  const h = await start(t, { stock: 0 });
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-10T05:00:00Z") });
  const id = h.insert("2026-11-01");
  const res = await h.approve(id);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: PASSED });
  assert.equal(h.db.prepare("SELECT status FROM borrow_requests WHERE id = ?").get(id).status, "pending");
  assert.equal(h.available(), 0);
});

test("the year turns at midnight in Phnom Penh on a UTC+14 host and on a UTC-11 host", async (t) => {
  useZone(t, "Pacific/Kiritimati"); // already Jan 1 here while Cambodia is still on Dec 31
  const h = await start(t);
  const lastDay = h.insert("2025-12-31");
  const lastDayLate = h.insert("2025-12-31");
  const newYear = h.insert("2026-01-01");

  t.mock.timers.enable({ apis: ["Date"], now: new Date("2025-12-31T16:59:59.999Z") });
  assert.equal((await h.approve(lastDay)).status, 200);
  assert.equal(h.db.prepare("SELECT return_date FROM borrow_requests WHERE id = ?").get(lastDay).return_date, "2026-01-07");

  process.env.TZ = "Pacific/Pago_Pago"; // still Dec 31 morning here while Cambodia is on Jan 1
  t.mock.timers.setTime(new Date("2025-12-31T17:00:00Z").getTime());
  const refused = await h.approve(lastDayLate);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: PASSED });
  const ok = await h.approve(newYear);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.request.returnDate, "2026-01-08");
  assert.equal(h.available(), 0);
});

test("on a Los Angeles host the student form and the approval agree on which day it is", async (t) => {
  useZone(t, "America/Los_Angeles");
  const h = await start(t);
  // 09:00 on Nov 9 in Los Angeles, 00:00 on Nov 10 in Phnom Penh.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-09T17:00:00Z") });
  const make = (borrowDate) =>
    h.call("POST", "/api/borrow-requests", { equipmentId: h.equipmentId, borrowDate }, h.student.cookie);

  const yesterday = await make("2026-11-09");
  assert.equal(yesterday.status, 400);
  assert.equal(yesterday.body.fields.borrowDate, "Borrow date cannot be in the past.");

  const today = await make("2026-11-10");
  assert.equal(today.status, 201);
  const id = today.body.request.id;
  assert.equal(today.body.request.returnDate, "2026-11-17");
  // Anything the form accepts can be approved at the same instant.
  const approved = await h.approve(id);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.request.status, "approved");
});

test("overdue and due-soon use the Cambodia day on a UTC host", async (t) => {
  useZone(t, "UTC");
  const h = await start(t, { stock: 5 });
  const late = h.insert("2026-11-09", "approved"); // due 2026-11-16
  const dueToday = h.insert("2026-11-10", "approved"); // due 2026-11-17
  const dueTomorrow = h.insert("2026-11-11", "approved"); // due 2026-11-18
  // 00:30 on Nov 17 in Phnom Penh, still 17:30 on Nov 16 in UTC.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-16T17:30:00Z") });

  const overdue = await h.call("GET", "/api/admin/overdue", undefined, h.admin.cookie);
  assert.equal(overdue.status, 200);
  assert.equal(overdue.body.today, "2026-11-17");
  assert.deepEqual(overdue.body.overdue.map((row) => [row.id, row.daysOverdue]), [[late, 1]]);
  assert.ok(!overdue.body.overdue.some((row) => row.id === dueToday));

  assert.equal(processDueReminders(h.db), 1);
  const notice = h.db.prepare("SELECT request_id FROM notifications WHERE type = 'due_soon'").all();
  assert.deepEqual(notice.map((n) => n.request_id), [dueTomorrow]);
});

// Bundles the admin page with a tiny fake React, as in approvalStartDate.test.js.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
async function loadPage() {
  const virtual = {
    react: `export const useCallback = (f) => f; export const useEffect = () => {};
      export const useState = (v) => { const s = globalThis.__B.slot++; if (!(s in globalThis.__B.state)) globalThis.__B.state[s] = v; return [globalThis.__B.state[s], () => {}]; };`,
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
    bundle: true, write: false, format: "esm", platform: "neutral", jsx: "automatic", jsxImportSource: "fake", logLevel: "silent",
    plugins: [{
      name: "fakes",
      setup(b) {
        b.onResolve({ filter: /^react$|^fake\/jsx-runtime$/ }, (a) => ({ path: a.path, namespace: "v" }));
        for (const source of Object.keys(fakes)) b.onResolve({ filter: new RegExp(source) }, () => ({ path: source, namespace: "v" }));
        b.onLoad({ filter: /.*/, namespace: "v" }, (a) => ({ contents: virtual[a.path] ?? fakes[a.path], loader: "js" }));
      },
    }],
  });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}
function* walk(node) {
  if (Array.isArray(node)) for (const child of node) yield* walk(child);
  else if (node && typeof node === "object") { yield node; yield* walk(node.props?.children); }
  else if (node != null) yield node;
}
const text = (node) => [...walk(node)].filter((n) => typeof n === "string" || typeof n === "number").join("");
const buttons = (tree) => [...walk(tree)].filter((n) => n.type === "button").map(text);

const pageRow = (id, borrowDate) => ({
  id, equipmentName: "Canon camera", equipmentAssetId: "CG-0002", requesterName: "Keo Dara", requesterRole: "student",
  borrowDate, returnDate: "2026-11-17", purpose: "", status: "pending", stock: 2,
});
// useState order in AdminBorrowRequests: 0 status, 1 data, 2 loading, 5 review.
const pageRows = (page, requests, today) => {
  const data = { requests, counts: { pending: requests.length } };
  if (today !== undefined) data.today = today;
  globalThis.__B = { slot: 0, state: { 1: data, 2: false, 5: null } };
  return [...walk(page.default())].filter((n) => n.type === "tr").slice(1);
};

test("in a Los Angeles browser just after midnight in Phnom Penh, the page marks yesterday's request", async (t) => {
  useZone(t, "America/Los_Angeles");
  const page = await loadPage();
  // 10:30 on Nov 9 in Los Angeles and 17:30 on Nov 9 in UTC, but 00:30 on Nov 10 in Phnom Penh.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-09T17:30:00Z") });
  const rows = pageRows(page, [pageRow(1, "2026-11-09"), pageRow(2, "2026-11-10")], todayISO());
  assert.match(text(rows[0]), /Start date passed/);
  assert.deepEqual(buttons(rows[0]), ["Reject"]);
  assert.deepEqual(buttons(rows[1]), ["Reject", "Approve"]);
});

test("the page follows the server's day when the browser clock disagrees, and falls back to its own without one", async (t) => {
  const page = await loadPage();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-09T17:30:00Z") }); // browser says Nov 10
  const requests = [pageRow(1, "2026-11-09"), pageRow(2, "2026-11-10")];

  // The server still says Nov 9 (a browser clock running ahead): nothing has passed yet.
  const behind = pageRows(page, requests, "2026-11-09");
  assert.doesNotMatch(text(behind[0]), /Start date passed/);
  assert.deepEqual(buttons(behind[0]), ["Reject", "Approve"]);

  // The server says Nov 11 (a browser clock running behind): both have passed.
  const ahead = pageRows(page, requests, "2026-11-11");
  assert.match(text(ahead[0]), /Start date passed/);
  assert.match(text(ahead[1]), /Start date passed/);

  // No data.today yet: the browser's own Cambodia day is used.
  const none = pageRows(page, requests);
  assert.match(text(none[0]), /Start date passed/);
  assert.doesNotMatch(text(none[1]), /Start date passed/);
});

test("the admin list returns the server's Cambodia day, not the host's", async (t) => {
  useZone(t, "America/Los_Angeles");
  const h = await start(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-09T17:30:00Z") });
  const res = await h.call("GET", "/api/admin/borrow-requests", undefined, h.admin.cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.today, "2026-11-10");
  assert.deepEqual(Object.keys(res.body).sort(), ["counts", "requests", "today"]);
});
