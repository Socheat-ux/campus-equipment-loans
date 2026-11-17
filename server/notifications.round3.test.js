// Round 3 review of SCRUM-11. Tests marked DEFECT fail until the defect is fixed; the rest guard round 2 fixes
// from angles earlier rounds did not try. The UI harness is the round 2 one (real NotificationBell.jsx bundled with
// esbuild, a tiny hooks stand-in, the real API), plus `offline` to make the browser's fetch fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
async function mountBell(t, { root, cookie, userId, offline = () => false }) {
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
  approve(db, a.id, "waiting");
  let down = true;
  const bellA = await mountBell(t, { root, cookie: a.cookie, userId: a.id, offline: (m) => down && m === "GET" });
  await bellA.click();
  assert.equal(bellA.sent.filter((r) => r.method === "POST").length, 0, "no { all, upTo: null } or upTo 0 is ever sent");
  await bellA.click(); // close
  down = false;
  await bellA.poll();
  await bellA.click();
  assert.deepEqual(bellA.sent.find((r) => r.method === "POST").body, { ids: [db.prepare("SELECT MAX(id) AS n FROM notifications").get().n] });
  assert.equal(unreadInDb(a.id), 0);

  const bellB = await mountBell(t, { root, cookie: b.cookie, userId: b.id });
  await bellB.click();
  assert.equal(bellB.sent.filter((r) => r.method === "POST").length, 0);
});

test("guard: the 'all' path stops at the newest id shown, so a notice that arrived after the poll stays unread and is announced", async (t) => {
  const { db, root, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  for (let i = 0; i <= LIST_LIMIT; i++) approve(db, a.id, `n${i}`);
  const shownTop = db.prepare("SELECT MAX(id) AS n FROM notifications").get().n;
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  const late = approve(db, a.id, "arrived after the last poll");
  await bell.click();
  assert.deepEqual(bell.sent.find((r) => r.method === "POST").body, { all: true, upTo: shownTop });
  assert.equal(unreadInDb(a.id), 1);
  assert.equal(db.prepare("SELECT read_at FROM notifications WHERE id = ?").get(late).read_at, null);
  await bell.poll();
  assert.match(bell.live(), /New notification\. 1 unread/);
});

test("guard: the alternating no-break space is the only difference, sits only at the end, and every repeat changes the text", async (t) => {
  const { db, root, signup, call } = await start(t);
  const a = await signup("sok.dara");
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  const heard = [];
  for (let i = 0; i < 4; i++) {
    approve(db, a.id, `n${i}`);
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
    const id = approve(db, a.id, `${seconds}`);
    db.prepare("UPDATE notifications SET created_at = ? WHERE id = ?").run(ago(seconds), id);
  }
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  await bell.click();
  const shown = bell.times().reverse(); // the list is newest id first; cases were inserted in order
  cases.forEach(([seconds, want], i) => assert.match(shown[i], want, `${seconds} s shown as "${shown[i]}"`));
});

test("guard: a teammate's notify after an await inside withTransaction writes nothing and raises no unhandled rejection", async (t) => {
  const { db, signup } = await start(t);
  const a = await signup("sok.dara");
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  let late;
  assert.throws(
    () =>
      withTransaction(db, async () => {
        await null;
        try {
          notify(db, { userId: a.id, type: "request_approved", message: "after the await" });
        } catch (err) {
          late = err;
          throw err;
        }
      }),
    /synchronous/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(late?.message ?? "", /withTransaction/, "the late notify call is refused with a clear message");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 0);
  assert.equal(unhandled.length, 0);
});

test("guard: { all, upTo } with an upTo taken from another user's notice marks only the caller's older rows", async (t) => {
  const { db, call, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  const b = await signup("chan.sophea");
  const a1 = approve(db, a.id, "a1");
  const b1 = approve(db, b.id, "b1");
  const a2 = approve(db, a.id, "a2");
  const res = await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { all: true, upTo: b1 } });
  assert.deepEqual(await res.json(), { unread: 1 });
  assert.notEqual(db.prepare("SELECT read_at FROM notifications WHERE id = ?").get(a1).read_at, null);
  assert.equal(db.prepare("SELECT read_at FROM notifications WHERE id = ?").get(a2).read_at, null);
  assert.equal(unreadInDb(b.id), 1, "the other user's notice is untouched");
});

// ---------- defects ----------

// DEFECT: package.json allows Node >= 22.13, but DatabaseSync.isTransaction only exists from Node 22.16.0 (and 24.0.0),
// per the Node sqlite docs. On 22.13 to 22.15 `db.isTransaction` is undefined, so notify's guard silently does nothing
// and a teammate's notify outside withTransaction is saved on its own, the exact mistake the guard is meant to catch.
// Fix: raise engines to ">=22.16" (one line), or refuse when typeof db.isTransaction !== "boolean".
test("DEFECT: notify's transaction guard holds on every Node version package.json allows", async (t) => {
  const { db, signup } = await start(t);
  const a = await signup("sok.dara");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const [maj, min] = pkg.engines.node.replace(/^>=\s*/, "").split(".").map(Number);
  const enginesOk = maj > 22 || (maj === 22 && min >= 16);
  // What notify sees on Node 22.13 to 22.15: the same database, without the isTransaction getter.
  const oldNodeDb = new Proxy(db, {
    get: (target, key) => (key === "isTransaction" ? undefined : typeof target[key] === "function" ? target[key].bind(target) : target[key]),
  });
  let refused = false;
  try {
    notify(oldNodeDb, { userId: a.id, type: "request_approved", message: "outside any transaction" });
  } catch {
    refused = true;
  }
  assert.ok(enginesOk || refused, `engines is "${pkg.engines.node}" and notify ran outside a transaction there`);
});

// DEFECT: a notice that arrives after the last poll is counted by the mark-read answer, so on open the badge says
// "1 unread" while the panel shows no unread or new item. Closing and opening again sends nothing (no unread item is
// listed), so for up to 30 s the user sees a count they can neither find nor clear. Fix: load the list when the panel
// opens (for example call load() after the mark-read settles), so the panel always shows what the badge counts.
test("DEFECT: when the panel is open, the badge never counts a notice the panel does not show", async (t) => {
  const { db, root, signup } = await start(t);
  const a = await signup("sok.dara");
  approve(db, a.id, "seen at the last poll");
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  approve(db, a.id, "arrived after the last poll");
  await bell.click();
  const listed = bell.items().map(textOf).join(" | ");
  assert.ok(
    bell.label() === "Notifications" || listed.includes("arrived after the last poll"),
    `badge says "${bell.label()}" but the open panel lists only: ${listed}`,
  );
});
