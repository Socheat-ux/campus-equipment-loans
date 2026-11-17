// Round 2 review of SCRUM-11. Tests marked DEFECT fail until the defect is fixed; the rest guard the round 1 fixes.
// The UI tests bundle the real NotificationBell.jsx and api.js with esbuild (already installed through Vite) and run
// them against a tiny hooks runtime and the real API. No DOM library: timers, fetch, document and window are faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { openDb, withTransaction } from "./db.js";
import { createApp } from "./app.js";
import { notify, LIST_LIMIT } from "./notifications.js";

const GOOD = "goodpass1";
const realFetch = globalThis.fetch; // the UI harness swaps fetch, so the test client keeps the real one
const realGlobals = { setInterval, clearInterval, fetch: realFetch, document: globalThis.document, window: globalThis.window };

async function start(t) {
  const db = openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, { body, cookie } = {}) =>
    realFetch(`${root}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const signup = async (name) => {
    const res = await call("POST", "/api/auth/signup", { body: { email: `${name}@student.cadt.edu.kh`, password: GOOD } });
    assert.equal(res.status, 201);
    const { user } = await res.json();
    return { cookie: res.headers.get("set-cookie").split(";")[0], id: user.id };
  };
  const unreadInDb = (userId) => db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(userId).n;
  return { db, root, call, signup, unreadInDb };
}

// notify needs a transaction; callers inside withTransaction already have one.
const approve = (db, userId, message = "ok") => {
  const run = () => notify(db, { userId, type: "request_approved", message });
  return db.isTransaction ? run() : withTransaction(db, run);
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---------- a tiny React stand-in, enough for one function component ----------

let bundled;
async function loadBellModule() {
  if (bundled) return bundled;
  const virtual = {
    react: `const R = () => globalThis.__R;
      export const useState = (v) => R().useState(v);
      export const useRef = (v) => R().useRef(v);
      export const useCallback = (f, d) => R().useMemo(() => f, d);
      export const useEffect = (f, d) => R().useEffect(f, d);
      export const useId = () => R().useRef(":r1:").current;`,
    "fake/jsx-runtime": `export const jsx = (t, p) => globalThis.__R.jsx(t, p);
      export const jsxs = jsx; export const Fragment = Symbol.for("fragment");`,
    auth: "export const useAuth = () => globalThis.__R.auth;",
    icons: "export const BellIcon = () => null;",
  };
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/notifications/NotificationBell.jsx", import.meta.url))],
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
          b.onResolve({ filter: /AuthContext\.jsx$/ }, () => ({ path: "auth", namespace: "v" }));
          b.onResolve({ filter: /Icons\.jsx$/ }, () => ({ path: "icons", namespace: "v" }));
          b.onLoad({ filter: /.*/, namespace: "v" }, (a) => ({ contents: virtual[a.path], loader: "js" }));
        },
      },
    ],
  });
  bundled = await import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
  return bundled;
}

function walk(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object") {
    out.push(node);
    walk(node.props?.children, out);
  }
  return out;
}
const textOf = (node) =>
  Array.isArray(node) ? node.map(textOf).join("") : typeof node === "string" || typeof node === "number" ? String(node) : node && typeof node === "object" ? textOf(node.props?.children) : "";

// Mounts the bell for one signed-in user. Requests go to the real API with that user's cookie.
async function mountBell(t, { root, cookie, userId }) {
  const { default: NotificationBell } = await loadBellModule();
  const R = { hooks: [], i: 0, pending: [], dirty: false, tree: null, auth: { user: { id: userId } } };
  R.useState = (init) => {
    const i = R.i++;
    if (!(i in R.hooks)) R.hooks[i] = { v: typeof init === "function" ? init() : init };
    const h = R.hooks[i];
    return [h.v, (next) => {
      const v = typeof next === "function" ? next(h.v) : next;
      if (!Object.is(v, h.v)) { h.v = v; R.dirty = true; }
    }];
  };
  R.useRef = (v) => {
    const i = R.i++;
    if (!(i in R.hooks)) R.hooks[i] = { current: v };
    return R.hooks[i];
  };
  R.useMemo = (f, deps) => {
    const i = R.i++;
    const h = R.hooks[i];
    if (h && deps.every((d, k) => Object.is(d, h.deps[k]))) return h.value;
    R.hooks[i] = { deps, value: f() };
    return R.hooks[i].value;
  };
  R.useEffect = (f, deps) => {
    const i = R.i++;
    const h = R.hooks[i];
    if (h && deps && deps.every((d, k) => Object.is(d, h.deps[k]))) return;
    R.pending.push(() => {
      h?.cleanup?.();
      R.hooks[i] = { deps, cleanup: f() };
    });
  };
  R.jsx = (type, props) => {
    if (typeof type === "function") return type(props);
    const el = {
      type,
      props,
      getBoundingClientRect: () => ({ bottom: 48 }),
      focus: () => (R.focused = el),
      contains: (target) => walk(el).includes(target),
    };
    if (props?.ref) props.ref.current = el;
    return el;
  };
  const render = () => {
    for (let n = 0; n === 0 || R.dirty; n++) {
      assert.ok(n < 50, "render loop");
      R.dirty = false;
      R.i = 0;
      R.pending = [];
      R.tree = NotificationBell({});
      R.pending.forEach((run) => run());
    }
  };

  const intervals = new Map();
  const listeners = {};
  const held = [];
  let inflight = 0;
  let hold = null; // when set, (method, path) => true holds that response until released
  const sent = [];
  const authExpired = [];

  globalThis.__R = R;
  globalThis.setInterval = (fn) => { const id = Symbol(); intervals.set(id, fn); return id; };
  globalThis.clearInterval = (id) => intervals.delete(id);
  globalThis.document = {
    addEventListener: (type, fn) => (listeners[type] ??= new Set()).add(fn),
    removeEventListener: (type, fn) => listeners[type]?.delete(fn),
  };
  globalThis.window = new EventTarget();
  globalThis.window.addEventListener("auth-expired", () => authExpired.push(Date.now()));
  globalThis.fetch = async (path, init = {}) => {
    inflight++;
    try {
      const method = init.method ?? "GET";
      sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
      const res = await realFetch(`${root}${path}`, { ...init, headers: { ...init.headers, cookie } });
      const copy = new Response(await res.text(), { status: res.status, headers: res.headers });
      if (hold?.(method, path)) {
        inflight--;
        await new Promise((release) => held.push(release));
        inflight++;
      }
      return copy;
    } finally {
      inflight--;
    }
  };
  const fakes = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  t.after(() => {
    Object.assign(globalThis, fakes); // unmount against this bell's own fakes, then put the real ones back
    R.hooks.forEach((h) => h?.cleanup?.());
    Object.assign(globalThis, realGlobals);
  });

  const settle = async () => {
    for (let quiet = 0; quiet < 5; ) {
      await tick();
      if (R.dirty) render();
      quiet = inflight === 0 && !R.dirty ? quiet + 1 : 0;
    }
  };
  render();
  await settle();

  const all = () => walk(R.tree);
  const ui = {
    R,
    sent,
    authExpired,
    settle,
    button: () => all().find((el) => el.props?.className === "notif-bell"),
    label: () => ui.button().props["aria-label"],
    live: () => textOf(all().find((el) => el.props?.["aria-live"])),
    items: () => all().filter((el) => el.type === "li"),
    times: () => all().filter((el) => el.type === "time").map(textOf),
    poll: async () => { [...intervals.values()].forEach((fn) => fn()); await settle(); },
    click: async () => { ui.button().props.onClick(); render(); await settle(); },
    holdNext: (pred) => (hold = pred),
    heldCount: () => held.length,
    releaseAll: async () => { hold = null; held.splice(0).forEach((release) => release()); await settle(); },
  };
  return ui;
}

// ---------- round 1 fixes, checked through the real component ----------

test("guard (fix 4): a poll answered before the mark-read is dropped, so the opened panel stays read", async (t) => {
  const { db, root, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  approve(db, a.id, "one");
  approve(db, a.id, "two");
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  assert.equal(bell.label(), "Notifications, 2 unread");

  bell.holdNext((method) => method === "GET"); // this poll's answer (2 unread) is computed now but arrives late
  await bell.poll();
  await bell.click();
  assert.equal(unreadInDb(a.id), 0);
  assert.equal(bell.label(), "Notifications");
  assert.equal(bell.heldCount(), 1, "the poll answer is really parked");
  await bell.releaseAll(); // the stale "2 unread" answer lands after the mark-read
  assert.equal(bell.label(), "Notifications", "a stale poll restored the old badge");
  assert.ok(bell.items().every((li) => li.props.className.includes("is-new")), "highlight stays until the panel closes");
});

test("guard (fix 3): the live region announces while closed, is cleared on open, and announces again after", async (t) => {
  const { db, root, signup } = await start(t);
  const a = await signup("sok.dara");
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  assert.equal(bell.live(), "", "nothing is announced on the first load");
  approve(db, a.id, "first");
  await bell.poll();
  assert.match(bell.live(), /New notification\. 1 unread/);
  await bell.click();
  assert.equal(bell.live(), "");
  await bell.click(); // close
  approve(db, a.id, "second");
  await bell.poll();
  assert.match(bell.live(), /New notification\. 1 unread/);
});

test("guard (fix 5): exactly 50 unread sends 50 ids, 51 unread sends { all: true }, and both end at 0", async (t) => {
  const { db, root, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  const b = await signup("chan.sophea");
  for (let i = 0; i < LIST_LIMIT; i++) approve(db, a.id, `a${i}`);
  for (let i = 0; i <= LIST_LIMIT; i++) approve(db, b.id, `b${i}`);

  const bellA = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  await bellA.click();
  const postA = bellA.sent.find((r) => r.method === "POST");
  assert.equal(postA.body.ids.length, LIST_LIMIT);
  assert.equal(unreadInDb(a.id), 0);

  const bellB = await mountBell(t, { root, cookie: b.cookie, userId: b.id });
  assert.equal(bellB.label(), `Notifications, ${LIST_LIMIT + 1} unread`);
  await bellB.click();
  // round 2 fixer: "all" now carries upTo, the newest id the bell has shown.
  const newestB = db.prepare("SELECT MAX(id) AS n FROM notifications WHERE user_id = ?").get(b.id).n;
  assert.deepEqual(bellB.sent.find((r) => r.method === "POST").body, { all: true, upTo: newestB });
  assert.equal(unreadInDb(b.id), 0);
  assert.equal(bellB.label(), "Notifications");
});

test("guard: a session that ends mid-poll fires auth-expired, and the bell keeps no error state", async (t) => {
  const { db, root, signup } = await start(t);
  const a = await signup("sok.dara");
  approve(db, a.id, "before logout elsewhere");
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(a.id); // logged out in another tab
  await bell.poll();
  assert.equal(bell.authExpired.length, 1);
  await bell.click(); // the mark-read also gets 401
  assert.equal(bell.authExpired.length, 2);
  assert.equal(bell.items().length, 1, "the last good list stays until the app unmounts the bell");
});

test("guard: an unknown future type (LK's 'overdue') renders a neutral chip, and long text renders whole", async (t) => {
  const { db, root, signup } = await start(t);
  const a = await signup("sok.dara");
  const long = "x".repeat(300);
  db.prepare("INSERT INTO notifications (user_id, type, message, reason) VALUES (?, 'overdue', ?, NULL)").run(a.id, long);
  withTransaction(db, () => notify(db, { userId: a.id, type: "request_rejected", message: "no", reason: "<b>r</b>".repeat(62) }));
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  await bell.click();
  const [rejected, overdue] = bell.items();
  assert.equal(textOf(overdue).includes("Update"), true);
  assert.equal(textOf(overdue).includes(long), true);
  assert.equal(textOf(rejected).includes("<b>r</b>".repeat(62)), true, "reason is shown as text, not markup");
});

// ---------- defects ----------

// DEFECT: "new" is detected by the unread count going up. If another tab reads a notice and a new one arrives
// inside one 30 s poll, the count stays the same, so this tab says nothing. Even when the count does go up
// to the same number as before, the text "New notification. 1 unread." is identical, React changes nothing in
// the DOM, and a screen reader stays silent. Fix: track the highest id seen, and clear the text before setting it.
test("DEFECT: a new notice is announced even when another tab read the old one in the same poll interval", async (t) => {
  const { db, root, signup, call } = await start(t);
  const a = await signup("sok.dara");
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  approve(db, a.id, "first");
  await bell.poll();
  const before = bell.live();
  assert.match(before, /New notification/);
  await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { all: true } }); // the other tab
  approve(db, a.id, "second");
  await bell.poll();
  assert.equal(bell.items().length, 0, "panel closed"); // sanity
  assert.notEqual(bell.live(), before, "the live region did not change, so the second notice was never announced");
});

// DEFECT: when a notice arrives after the last poll and the user opens the panel, the mark-read answer
// (which counts that notice) becomes lastUnread. The next poll shows the same count, so the notice appears
// in the open panel, unread and unhighlighted, and is never announced.
test("DEFECT: a notice that arrives just before the panel opens is announced when it shows up", async (t) => {
  const { db, root, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  approve(db, a.id, "old");
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  const fresh = approve(db, a.id, "arrived after the last poll");
  await bell.click();
  assert.equal(unreadInDb(a.id), 1, "only the shown notice was marked");
  await bell.poll();
  assert.equal(bell.items().length, 2, `notice ${fresh} is in the open panel now`);
  assert.match(bell.live(), /New notification/, "the new notice was never announced");
});

// DEFECT: timeAgo trusts the browser clock. A phone or laptop whose clock is a few minutes slow shows a
// notice that was just created as "in 3 minutes". Fix: clamp to the past, e.g. Math.min(0, seconds).
test("DEFECT: a browser clock that runs behind the server never shows a notice as in the future", async (t) => {
  const { db, root, signup } = await start(t);
  const a = await signup("sok.dara");
  const id = approve(db, a.id, "just approved");
  const serverNow = new Date(Date.now() + 3 * 60_000).toISOString(); // the browser is 3 minutes slow
  db.prepare("UPDATE notifications SET created_at = ? WHERE id = ?").run(serverNow, id);
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  await bell.click();
  const [shown] = bell.times();
  assert.doesNotMatch(shown, /^in /, `shown as "${shown}"`);
});

// ---------- server edges not covered in round 0 or 1 ----------

test("guard (fix 6): opening a file database that still has the old index drops it and keeps every row", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "notif-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "app.db");
  const old = openDb(path);
  old.exec("DROP INDEX notifications_user_id; CREATE INDEX notifications_user_created ON notifications (user_id, created_at)");
  old.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES ('a@student.cadt.edu.kh', 'A', 'student', 'x')").run();
  approve(old, 1, "kept");
  old.close();

  for (let i = 0; i < 2; i++) openDb(path).close(); // idempotent across restarts
  const raw = new DatabaseSync(path);
  const names = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notifications'").all().map((r) => r.name);
  assert.deepEqual(names, ["notifications_user_id"]);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 1);
  const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT id FROM notifications WHERE user_id = 1 ORDER BY id DESC LIMIT 50").all();
  assert.match(plan.map((p) => p.detail).join(" "), /notifications_user_id/);
  assert.doesNotMatch(plan.map((p) => p.detail).join(" "), /TEMP B-TREE/, "newest-first needs no sort");
  raw.close();
});

test("guard (fix 1): seed:test resolves a relative DB_PATH from .env against the folder it runs in, and an argument wins", (t) => {
  const script = fileURLToPath(new URL("./seed-dev.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "seed-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, ".env"), "NODE_ENV=development\nDB_PATH=nested/dev.db\n");
  const env = { ...process.env };
  delete env.NODE_ENV;
  delete env.DB_PATH;
  const run = (...extra) => spawnSync(process.execPath, ["--env-file-if-exists=.env", script, ...extra], { cwd: dir, env, encoding: "utf8" });
  assert.equal(run().status, 0);
  assert.equal(existsSync(join(dir, "nested", "dev.db")), true);
  assert.equal(run("other.db").status, 0);
  assert.equal(existsSync(join(dir, "other.db")), true);
  const raw = new DatabaseSync(join(dir, "nested", "dev.db"));
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 2, "sample notices added once");
  raw.close();
});

test("guard: two tabs marking at once both succeed, and the first read time is never overwritten", async (t) => {
  const { db, call, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  const ids = Array.from({ length: 30 }, (_, i) => approve(db, a.id, `n${i}`));
  const first = await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { ids: [ids[0]] } });
  assert.equal(first.status, 200);
  const stamp = db.prepare("SELECT read_at FROM notifications WHERE id = ?").get(ids[0]).read_at;
  const answers = await Promise.all([
    call("POST", "/api/notifications/read", { cookie: a.cookie, body: { ids } }),
    call("POST", "/api/notifications/read", { cookie: a.cookie, body: { all: true } }),
    call("GET", "/api/notifications", { cookie: a.cookie }),
  ]);
  assert.deepEqual(answers.map((r) => r.status), [200, 200, 200]);
  assert.equal(unreadInDb(a.id), 0);
  assert.equal(db.prepare("SELECT read_at FROM notifications WHERE id = ?").get(ids[0]).read_at, stamp);
});

test("guard: ids beyond the safe integer range or SQLite's range are a clean no-op, never a 500", async (t) => {
  const { db, call, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  approve(db, a.id);
  for (const ids of [[1e300], [2 ** 63], [Number.MAX_SAFE_INTEGER + 2], Array(LIST_LIMIT).fill(1)]) {
    const res = await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { ids } });
    assert.equal(res.status, 200, String(ids[0]));
  }
  assert.equal(unreadInDb(a.id), 0, "the repeated id 1 was marked");
  assert.equal((await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { all: false } })).status, 400);
  assert.equal((await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { ids: Array(LIST_LIMIT + 1).fill(1) } })).status, 400);
});

test("guard: a teammate's notify for a user that does not exist throws and leaves the transaction unapplied", async (t) => {
  const { db } = await start(t);
  const { withTransaction } = await import("./db.js");
  db.exec("CREATE TABLE requests (id INTEGER PRIMARY KEY, status TEXT)");
  db.prepare("INSERT INTO requests (id, status) VALUES (7, 'pending')").run();
  assert.throws(() =>
    withTransaction(db, () => {
      db.prepare("UPDATE requests SET status = 'approved' WHERE id = 7").run();
      notify(db, { userId: 9999, type: "request_approved", message: "ok" }); // passed the wrong id
    }),
  );
  assert.equal(db.prepare("SELECT status FROM requests WHERE id = 7").get().status, "pending");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 0);
});
