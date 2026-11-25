// Round 3 review of SCRUM-11. Tests marked DEFECT fail until the defect is fixed; the rest guard round 2 fixes
// from angles earlier rounds did not try. The UI harness is the round 2 one (real NotificationBell.jsx bundled with
// esbuild, a tiny hooks stand-in, the real API), plus `offline` to make the browser's fetch fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { openDb, withTransaction } from "./db.js";
import { createApp } from "./app.js";
import { notify, LIST_LIMIT } from "./notifications.js";

const GOOD = "goodpass1";
const realFetch = globalThis.fetch; // the UI harness swaps fetch, so the test client keeps the real one
const realGlobals = { setInterval, clearInterval, fetch: realFetch, document: globalThis.document, window: globalThis.window };

async function start(t) {
  const db = await openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await db.close();
  });
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
  const unreadInDb = async (userId) =>
    (await db.prepare("SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(userId)).n;
  return { db, root, call, signup, unreadInDb };
}

// notify needs a transaction; callers inside withTransaction already have one.
const approve = (db, userId, message = "ok") => {
  const run = (conn) => notify(conn, { userId, type: "request_approved", message });
  return db.isTransaction ? run(db) : withTransaction(db, run);
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---------- a tiny React stand-in, enough for one function component ----------

let bundled;
async function loadBellModule() {
  if (bundled) return bundled;
  const rootDir = fileURLToPath(new URL("../", import.meta.url));
  const virtual = {
    entry: `export { default } from "./frontend/src/notifications/NotificationBell.jsx";`,
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
    entryPoints: ["entry"],
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
          b.onResolve({ filter: /^entry$/ }, () => ({ path: "entry", namespace: "v" }));
          b.onResolve({ filter: /^react$|^fake\/jsx-runtime$/ }, (a) => ({ path: a.path, namespace: "v" }));
          b.onResolve({ filter: /AuthContext\.jsx$/ }, () => ({ path: "auth", namespace: "v" }));
          b.onResolve({ filter: /Icons\.jsx$/ }, () => ({ path: "icons", namespace: "v" }));
          b.onLoad({ filter: /.*/, namespace: "v" }, (a) => ({ contents: virtual[a.path], loader: "js", resolveDir: rootDir }));
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
async function mountBell(t, { root, cookie, userId, offline = () => false }) {
  const { default: Root } = await loadBellModule();
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
      getBoundingClientRect: () => ({ height: 48, bottom: 48 }),
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
      R.tree = Root({});
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
      if (offline(method, path)) throw new TypeError("Failed to fetch");
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

// ---------- round 2 fixes, attacked from new angles ----------

test("guard: with nothing loaded (offline first load, or zero notices) opening never sends a mark-read", async (t) => {
  const { db, root, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  const b = await signup("chan.sophea");
  await approve(db, a.id, "waiting");
  let down = true;
  const bellA = await mountBell(t, { root, cookie: a.cookie, userId: a.id, offline: (m) => down && m === "GET" });
  await bellA.click();
  assert.equal(bellA.sent.filter((r) => r.method === "POST").length, 0, "no { all, upTo: null } or upTo 0 is ever sent");
  await bellA.click(); // close
  down = false;
  await bellA.poll();
  await bellA.click();
  assert.deepEqual(bellA.sent.find((r) => r.method === "POST").body, { ids: [(await db.prepare("SELECT MAX(id) AS n FROM notifications").get()).n] });
  assert.equal(await unreadInDb(a.id), 0);

  const bellB = await mountBell(t, { root, cookie: b.cookie, userId: b.id });
  await bellB.click();
  assert.equal(bellB.sent.filter((r) => r.method === "POST").length, 0);
});

test("guard: the 'all' path stops at the newest id shown, so a notice that arrived after the poll stays unread and is announced", async (t) => {
  const { db, root, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  for (let i = 0; i <= LIST_LIMIT; i++) await approve(db, a.id, `n${i}`);
  const shownTop = (await db.prepare("SELECT MAX(id) AS n FROM notifications").get()).n;
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  const late = await approve(db, a.id, "arrived after the last poll");
  await bell.click();
  assert.deepEqual(bell.sent.find((r) => r.method === "POST").body, { all: true, upTo: shownTop });
  assert.equal(await unreadInDb(a.id), 1);
  assert.equal((await db.prepare("SELECT read_at FROM notifications WHERE id = ?").get(late)).read_at, null);
  await bell.poll();
  assert.match(bell.live(), /New notification\. 1 unread/);
});

test("guard: the alternating no-break space is the only difference, sits only at the end, and every repeat changes the text", async (t) => {
  const { db, root, signup, call } = await start(t);
  const a = await signup("sok.dara");
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  const heard = [];
  for (let i = 0; i < 4; i++) {
    await approve(db, a.id, `n${i}`);
    await bell.poll();
    heard.push(bell.live());
    await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { all: true } }); // another tab reads it
  }
  for (let i = 1; i < heard.length; i++) assert.notEqual(heard[i], heard[i - 1], `announcement ${i} repeats the DOM text`);
  for (const text of heard) {
    const plain = text.replace(/ $/, "");
    assert.equal(plain, "New notification. 1 unread.");
    assert.doesNotMatch(plain, /\s$|^\s| /);
  }
});

test("guard: time labels floor at each unit boundary and clamp the future", async (t) => {
  const { db, root, signup } = await start(t);
  const a = await signup("sok.dara");
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  const cases = [
    [-86_400, /^just now$/], // a day in the future
    [55, /^just now$/],
    [61, /^1 minute ago$/],
    [3_590, /^59 minutes ago$/],
    [3_601, /^1 hour ago$/],
    [86_400 * 2 - 60, /^yesterday$/],
    [86_400 * 6.9, /^6 days ago$/],
  ];
  for (const [seconds] of cases) {
    const id = await approve(db, a.id, `${seconds}`);
    await db.prepare("UPDATE notifications SET created_at = ? WHERE id = ?").run(ago(seconds), id);
  }
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  await bell.click();
  const shown = bell.times().reverse(); // the list is newest id first; cases were inserted in order
  cases.forEach(([seconds, want], i) => assert.match(shown[i], want, `${seconds} s shown as "${shown[i]}"`));
});

test("guard: a teammate's notify on the top-level db writes nothing and raises no unhandled rejection; on the transaction connection after an await it commits or rolls back with the transaction", async (t) => {
  const { db, signup } = await start(t);
  const a = await signup("sok.dara");
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const count = async () => (await db.prepare("SELECT COUNT(*)::int AS n FROM notifications").get()).n;
  const input = (message) => ({ userId: a.id, type: "request_approved", message });

  // Outside any transaction: the top-level db is refused with a clear message and nothing is stored.
  await assert.rejects(notify(db, input("outside")), /withTransaction/);
  // Inside a transaction but through the top-level db instead of the connection: refused too, and the transaction fails with it.
  let late;
  await assert.rejects(
    withTransaction(db, async () => {
      await null;
      try {
        await notify(db, input("after the await, wrong handle"));
      } catch (err) {
        late = err;
        throw err;
      }
    }),
    /withTransaction/,
  );
  assert.match(late?.message ?? "", /withTransaction/, "the wrong-handle notify call is refused with a clear message");
  assert.equal(await count(), 0);

  // On the transaction connection after an await: written, and committed with the transaction.
  await withTransaction(db, async (tx) => {
    await null;
    await notify(tx, input("committed after an await"));
    assert.equal((await tx.prepare("SELECT COUNT(*)::int AS n FROM notifications").get()).n, 1);
  });
  assert.equal(await count(), 1);

  // Same call, but the transaction fails afterwards: the notice goes with it.
  await assert.rejects(
    withTransaction(db, async (tx) => {
      await null;
      await notify(tx, input("rolled back"));
      throw new Error("the change this notice reports failed");
    }),
    /the change this notice reports failed/,
  );
  assert.equal(await count(), 1);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unhandled.length, 0);
});

test("guard: { all, upTo } with an upTo taken from another user's notice marks only the caller's older rows", async (t) => {
  const { db, call, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  const b = await signup("chan.sophea");
  const a1 = await approve(db, a.id, "a1");
  const b1 = await approve(db, b.id, "b1");
  const a2 = await approve(db, a.id, "a2");
  const res = await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { all: true, upTo: b1 } });
  assert.deepEqual(await res.json(), { unread: 1 });
  assert.notEqual((await db.prepare("SELECT read_at FROM notifications WHERE id = ?").get(a1)).read_at, null);
  assert.equal((await db.prepare("SELECT read_at FROM notifications WHERE id = ?").get(a2)).read_at, null);
  assert.equal(await unreadInDb(b.id), 1, "the other user's notice is untouched");
});

// ---------- defects ----------

// The guard used to read node:sqlite's DatabaseSync.isTransaction, which only exists from Node 22.16. It now reads the
// adapter's own isTransaction flag, so it does not depend on node:sqlite or the Node version at all.
test("DEFECT: notify's transaction guard holds on every Node version package.json allows", async (t) => {
  const { db, signup } = await start(t);
  const a = await signup("sok.dara");
  const input = { userId: a.id, type: "request_approved", message: "outside any transaction" };
  const count = async () => (await db.prepare("SELECT COUNT(*)::int AS n FROM notifications").get()).n;
  // The top-level db, and a stand-in object whose only transaction signal is isTransaction: false.
  const falseFlag = { isTransaction: false, prepare: db.prepare.bind(db) };
  assert.equal(db.isTransaction, false);
  await assert.rejects(notify(db, input), /withTransaction/);
  await assert.rejects(notify(falseFlag, input), /withTransaction/);
  assert.equal(await count(), 0, "a refused notify writes nothing");
  // The transaction connection carries the flag as true and is accepted.
  await withTransaction(db, async (tx) => {
    assert.equal(tx.isTransaction, true);
    await notify(tx, input);
  });
  assert.equal(await count(), 1);
});

// DEFECT: a notice that arrives after the last poll is counted by the mark-read answer, so on open the badge says
// "1 unread" while the panel shows no unread or new item. Closing and opening again sends nothing (no unread item is
// listed), so for up to 30 s the user sees a count they can neither find nor clear. Fix: load the list when the panel
// opens (for example call load() after the mark-read settles), so the panel always shows what the badge counts.
test("DEFECT: when the panel is open, the badge never counts a notice the panel does not show", async (t) => {
  const { db, root, signup } = await start(t);
  const a = await signup("sok.dara");
  await approve(db, a.id, "seen at the last poll");
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  await approve(db, a.id, "arrived after the last poll");
  await bell.click();
  const listed = bell.items().map(textOf).join(" | ");
  assert.ok(
    bell.label() === "Notifications, 0 unread" || listed.includes("arrived after the last poll"),
    `badge says "${bell.label()}" but the open panel lists only: ${listed}`,
  );
});
