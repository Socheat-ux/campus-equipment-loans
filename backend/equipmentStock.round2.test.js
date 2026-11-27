import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { seedTestAccounts } from "./seed-dev.js";
import { addDaysISO, todayISO } from "../shared/rules.js";
import { asCard } from "../frontend/src/equipment/cards.js";

const GOOD = "goodpass1";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Every student is created once, up front, so the signup limiter (100 per address) is never close.
async function start(t, studentCount = 6) {
  const db = await openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.close(); await db.close(); });
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
  const { id: adminId, cookie: admin } = await signup("chan.nita@cadt.edu.kh");
  await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminId);
  const students = [];
  for (let i = 1; i <= studentCount; i += 1) students.push((await signup(`keo.bopha${i}@student.cadt.edu.kh`)).cookie);

  const item = async (quantity, name = "Canon camera") =>
    (await call("POST", "/api/equipment", admin, { name, category: "Camera", quantity })).body.equipment.id;
  const edit = (id, quantity, name = "Canon camera", category = "Camera") =>
    call("PUT", `/api/equipment/${id}`, admin, { name, category, quantity });
  const ask = (student, equipmentId) =>
    call("POST", "/api/borrow-requests", students[student], {
      equipmentId,
      borrowDate: addDaysISO(todayISO(), 2),
      purpose: "Media club shoot",
    });
  const approve = (id) => call("POST", `/api/admin/borrow-requests/${id}/approve`, admin);
  const reject = (id) => call("POST", `/api/admin/borrow-requests/${id}/reject`, admin, { reason: "Booked that week" });
  const giveBack = (id) => call("POST", `/api/admin/borrow-requests/${id}/return`, admin);
  const cancel = (id) => call("POST", `/api/admin/borrow-requests/${id}/cancel`, admin, { reason: "Mistake" });
  const row = (id) => db.prepare("SELECT * FROM equipment WHERE id = ?").get(id);
  const approvedCount = async (id) =>
    (await db.prepare("SELECT COUNT(*)::int AS n FROM borrow_requests WHERE equipment_id = ? AND status = 'approved'").get(id)).n;
  return { db, item, edit, ask, approve, reject, giveBack, cancel, row, approvedCount };
}

test("a student is refused when the total is above 0 but nothing is on the shelf, and gets in after a return", async (t) => {
  const h = await start(t, 4);
  const id = await h.item(3);
  const loans = [];
  for (let s = 0; s < 3; s += 1) {
    const sent = await h.ask(s, id);
    assert.equal(sent.status, 201);
    assert.equal((await h.approve(sent.body.request.id)).status, 200);
    loans.push(sent.body.request.id);
  }
  assert.equal((await h.row(id)).quantity, 3);
  assert.equal((await h.row(id)).available, 0);

  const before = (await h.db.prepare("SELECT COUNT(*)::int AS n FROM borrow_requests").get()).n;
  const refused = await h.ask(3, id);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.fields.equipmentId, "This item is no longer available.");
  assert.equal((await h.db.prepare("SELECT COUNT(*)::int AS n FROM borrow_requests").get()).n, before, "no row was added");

  assert.equal((await h.giveBack(loans[0])).status, 200);
  assert.equal((await h.ask(3, id)).status, 201);
});

test("the demo seed leaves laptop stock consistent, repeats safely, and skips the loan when the shelf is empty", async () => {
  const db = await openDb(":memory:");
  try {
    await seedTestAccounts(db);
    const laptop = () => db.prepare("SELECT * FROM equipment WHERE name LIKE 'Dell Latitude%'").get();
    const approved = async () =>
      (await db.prepare("SELECT COUNT(*)::int AS n FROM borrow_requests WHERE equipment_id = ? AND status = 'approved'").get((await laptop()).id)).n;
    const row = await laptop();
    assert.equal(row.quantity, 5);
    assert.equal(row.available, 4);
    assert.equal(row.quantity - row.available, await approved());

    const snapshot = async () =>
      JSON.stringify([
        await db.prepare("SELECT * FROM equipment ORDER BY id").all(),
        await db.prepare("SELECT * FROM borrow_requests ORDER BY id").all(),
      ]);
    const first = await snapshot();
    await seedTestAccounts(db);
    assert.equal(await snapshot(), first, "a second run changes nothing");
  } finally {
    await db.close();
  }

  const empty = await openDb(":memory:");
  try {
    await empty.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Dell Latitude 5440 Laptop', 'Laptop', 5)").run();
    await empty.prepare("UPDATE equipment SET available = 0").run();
    await seedTestAccounts(empty);
    assert.equal((await empty.prepare("SELECT COUNT(*)::int AS n FROM borrow_requests").get()).n, 0, "no demo loan on an empty shelf");
    assert.equal((await empty.prepare("SELECT available FROM equipment").get()).available, 0);
  } finally {
    await empty.close();
  }
});

// mulberry32: a tiny seeded generator so a failing run can be replayed.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("200 random operations never break 0 <= available <= total or total - available = approved loans", async (t) => {
  const h = await start(t, 6);
  const rand = mulberry32(41);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const items = [await h.item(3, "Canon camera"), await h.item(2, "Epson projector")];
  const byStatus = async (id, status) =>
    (await h.db.prepare("SELECT id FROM borrow_requests WHERE equipment_id = ? AND status = ?").all(id, status)).map((r) => r.id);
  const seen = new Set();

  for (let step = 0; step < 200; step += 1) {
    const id = pick(items);
    const op = pick(["request", "request", "approve", "approve", "reject", "return", "cancel", "edit"]);
    const before = { ...(await h.row(id)) };
    seen.add(op);

    if (op === "request") {
      const who = Math.floor(rand() * 6);
      // SCRUM-46: a student can hold only one pending request per item; that rule is checked before stock.
      const waiting = await h.db
        .prepare("SELECT 1 FROM borrow_requests r JOIN users u ON u.id = r.user_id WHERE u.email = ? AND r.equipment_id = ? AND r.status = 'pending'")
        .get(`keo.bopha${who + 1}@student.cadt.edu.kh`, id);
      const res = await h.ask(who, id);
      assert.equal(res.status, waiting ? 409 : before.available < 1 ? 400 : 201, `step ${step} request`);
    } else if (op === "approve" || op === "reject") {
      const pending = await byStatus(id, "pending");
      if (pending.length) {
        const res = await h[op](pick(pending));
        assert.equal(res.status, op === "approve" && before.available < 1 ? 409 : 200, `step ${step} ${op}`);
      }
    } else if (op === "return" || op === "cancel") {
      const open = op === "return" ? await byStatus(id, "approved") : [...(await byStatus(id, "approved")), ...(await byStatus(id, "rejected"))];
      if (open.length) assert.equal((await (op === "return" ? h.giveBack : h.cancel)(pick(open))).status, 200, `step ${step} ${op}`);
    } else {
      const total = Math.floor(rand() * 7);
      const onLoan = await h.approvedCount(id);
      const res = await h.edit(id, total);
      if (total < onLoan) {
        assert.equal(res.status, 400, `step ${step} edit`);
        assert.equal(res.body.fields.quantity, `Total cannot be lower than the ${onLoan} ${onLoan === 1 ? "item" : "items"} on loan.`);
        assert.deepEqual({ ...(await h.row(id)) }, before, "a refused edit leaves the row alone");
      } else {
        assert.equal(res.status, 200, `step ${step} edit`);
        assert.equal((await h.row(id)).available, total - onLoan);
      }
    }

    for (const each of items) {
      const { quantity, available } = await h.row(each);
      assert.ok(available >= 0 && available <= quantity, `step ${step} (${op}): ${available} of ${quantity}`);
      assert.equal(quantity - available, await h.approvedCount(each), `step ${step} (${op}): drift`);
    }
  }
  assert.equal(seen.size, 6, "every kind of operation ran");
});

test("an edit that keeps the total moves nothing, and a numeric string is read as a number", async (t) => {
  const h = await start(t, 2);
  const id = await h.item(2);
  for (let s = 0; s < 2; s += 1) assert.equal((await h.approve((await h.ask(s, id)).body.request.id)).status, 200);
  const { quantity, available } = await h.row(id);
  assert.deepEqual({ quantity, available }, { quantity: 2, available: 0 });

  const renamed = await h.edit(id, 2, "Canon R5 camera", "Laptop");
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.equipment.name, "Canon R5 camera");
  assert.equal(renamed.body.equipment.category, "Laptop");
  assert.equal((await h.row(id)).available, 0);

  const asString = await h.edit(id, "2");
  assert.equal(asString.status, 200);
  assert.equal((await h.row(id)).available, 0);

  const before = { ...(await h.row(id)) };
  const lowered = await h.edit(id, "1");
  assert.equal(lowered.status, 400);
  assert.equal(lowered.body.fields.quantity, "Total cannot be lower than the 2 items on loan.");
  assert.deepEqual({ ...(await h.row(id)) }, before);
});

// No DOM library: the real pages are bundled with tiny React/module fakes, then the tree is inspected.
async function loadPage(entry, fakes) {
  const virtual = {
    react: `export const useCallback = (f) => f;
      export const useEffect = () => {};
      export const useMemo = (f) => f();
      export const useState = (v) => {
        const slot = globalThis.__U.slot++;
        if (!(slot in globalThis.__U.state)) globalThis.__U.state[slot] = globalThis.__U.init?.[slot] ?? v;
        return [globalThis.__U.state[slot], () => {}];
      };`,
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
          b.onResolve({ filter: /^react$|^fake\/jsx-runtime$/ }, (a) => ({ path: a.path, namespace: "v" }));
          for (const source of Object.keys(fakes)) b.onResolve({ filter: new RegExp(source) }, () => ({ path: source, namespace: "v" }));
          b.onLoad({ filter: /.*/, namespace: "v" }, (a) => ({ contents: virtual[a.path] ?? fakes[a.path], loader: "js" }));
        },
      },
    ],
  });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}

function render(page, props, init) {
  globalThis.__U = { slot: 0, state: {}, init, auth: { user: { role: "admin" } } };
  return page.default(props);
}
function* walk(node) {
  if (Array.isArray(node)) for (const child of node) yield* walk(child);
  else if (node && typeof node === "object") {
    yield node;
    yield* walk(node.props?.children);
  } else if (node != null) yield node;
}
const text = (node) => [...walk(node)].filter((n) => typeof n !== "object").join("");
const cells = (tree) => [...walk(tree)].filter((n) => n.type === "td").map(text);

const NOTHING = "export default () => null;";
const LAYOUT = "export default ({ children }) => children;";

test("the equipment table shows 'x of y available', also at 0", async () => {
  const page = await loadPage("frontend/src/pages/EquipmentDashboard.jsx", {
    "equipment/api[.]js$": "export const createEquipment = 0, deleteEquipment = 0, listEquipment = 0, updateEquipment = 0;",
    "AuthContext[.]jsx$": "export const useAuth = () => globalThis.__U.auth;",
    "layouts/DashboardLayout[.]jsx$": LAYOUT,
    "equipment/EquipmentDrawer[.]jsx$": NOTHING,
    "equipment/Toast[.]jsx$": NOTHING,
  });
  const tree = render(page, {
    initialEquipment: [
      { id: 1, name: "A", category: "Laptop", quantity: 3, available: 1 },
      { id: 2, name: "B", category: "Audio", quantity: 0, available: 0 },
    ],
  });
  const all = cells(tree);
  assert.ok(all.includes("1 of 3 available"), all.join(" | "));
  assert.ok(all.includes("0 of 0 available"), all.join(" | "));
});

test("an admin request row with no stock shows '0 of 2 available'", async () => {
  const page = await loadPage("frontend/src/pages/AdminBorrowRequests.jsx", {
    "layouts/DashboardLayout[.]jsx$": LAYOUT,
    "equipment/Toast[.]jsx$": NOTHING,
    "auth/AuthUI[.]jsx$": "export const ErrorText = () => null;",
    "borrowRequests/adminApi[.]js$":
      "export const approveBorrowRequest = 0, cancelBorrowRequestAdmin = 0, listAdminBorrowRequests = 0, rejectBorrowRequest = 0, returnBorrowRequest = 0;",
  });
  const request = {
    id: 9,
    equipmentName: "Canon camera",
    equipmentAssetId: "CG-0001",
    requesterName: "Sok Dara",
    requesterRole: "student",
    borrowDate: "2026-12-01",
    returnDate: "2026-12-08",
    status: "pending",
    stock: 0,
    total: 2,
  };
  // state slots in order: status, data, loading
  const tree = render(page, {}, { 1: { requests: [request], counts: { pending: 1 } }, 2: false });
  assert.ok(cells(tree).includes("0 of 2 available"), cells(tree).join(" | "));
});

test("a catalogue card shows 'x of y available' for an out-of-stock item", async () => {
  const page = await loadPage("frontend/src/pages/HomePage.jsx", {
    "react-router-dom$": "export const Link = () => null;",
    "equipment/api[.]js$": "export const listEquipment = 0;",
    "components/StudentHeader[.]jsx$": NOTHING,
  });
  const tree = render(page, {}, { 0: [asCard({ id: 2, name: "B", category: "Audio", quantity: 2, available: 0 })], 1: false });
  const badge = [...walk(tree)].find((n) => typeof n.props?.className === "string" && n.props.className.startsWith("stock-badge"));
  assert.equal(badge.props.className, "stock-badge out-stock");
  assert.equal(text(badge), "0 of 2 available");
});

test("every placeholder in the app starts with 'Enter'", () => {
  const files = readdirSync(join(ROOT, "frontend", "src"), { recursive: true }).filter((f) => f.endsWith(".jsx"));
  let found = 0;
  for (const file of files) {
    const source = readFileSync(join(ROOT, "frontend", "src", file), "utf8");
    for (const match of source.matchAll(/placeholder=(\{[^}]*\}|"[^"]*"|'[^']*')/g)) {
      found += 1;
      assert.match(match[1], /^"Enter /, `${file}: ${match[0]}`);
    }
  }
  assert.ok(found >= 10, "the scan found the placeholders");
});
