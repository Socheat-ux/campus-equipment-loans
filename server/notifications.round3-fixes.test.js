// Round 3 fixes. Tests for the announcement count, the "12 months" label, the pointerdown close and the reload after
// mark-read. The UI harness is copied from notifications.round3.test.js (real NotificationBell.jsx bundled with esbuild,
// a tiny hooks stand-in, the real API); the only additions are `fire` and `listenerTypes` on the returned handle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { openDb, withTransaction } from "./db.js";
import { createApp } from "./app.js";
import { notify, MESSAGE_MAX, REASON_MAX } from "./notifications.js";

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
    listenerTypes: () => Object.keys(listeners).filter((type) => listeners[type].size),
    fire: (type, target) => [...(listeners[type] ?? [])].forEach((fn) => fn({ type, target })),
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

const DAY = 86_400;

test("announcement: several new notices in one poll say how many, one says the old text, repeats still change the DOM", async (t) => {
  const { db, root, signup, call } = await start(t);
  const a = await signup("sok.dara");
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  const readAll = () => call("POST", "/api/notifications/read", { cookie: a.cookie, body: { all: true } });

  approve(db, a.id, "one");
  await bell.poll();
  assert.equal(bell.live().replace(/ $/, ""), "New notification. 1 unread.");
  await readAll();

  for (const id of [1, 2]) approve(db, a.id, `pair ${id}`);
  await bell.poll();
  const first = bell.live();
  assert.equal(first.replace(/ $/, ""), "2 new notifications. 2 unread.");
  await readAll();

  for (const id of [1, 2]) approve(db, a.id, `again ${id}`);
  await bell.poll();
  assert.equal(bell.live().replace(/ $/, ""), "2 new notifications. 2 unread.");
  assert.notEqual(bell.live(), first, "the same words twice in a row must still change the DOM text");

  // The count is of new notices, not of unread ones: another tab read all three before this tab polled.
  for (const id of [1, 2, 3]) approve(db, a.id, `trio ${id}`);
  await readAll();
  await bell.poll();
  assert.match(bell.live(), /^3 new notifications\. 0 unread\./);
});

test("timeAgo: never prints 12 months, years start at 365 days", async (t) => {
  const { db, root, signup } = await start(t);
  const a = await signup("sok.dara");
  const days = [330, 359, 360, 364, 365, 400, 729, 730, 1100];
  for (const d of days) {
    const id = approve(db, a.id, `${d} days`);
    db.prepare("UPDATE notifications SET created_at = ? WHERE id = ?").run(new Date(Date.now() - (d * DAY + 60) * 1000).toISOString(), id);
  }
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  await bell.click();
  const shown = bell.times().reverse(); // newest id first, so reversed matches insertion order
  const by = Object.fromEntries(days.map((d, i) => [d, shown[i]]));
  assert.ok(!shown.some((text) => /12 months/.test(text)), `a label says 12 months: ${shown.join(", ")}`);
  for (const d of [330, 359, 360, 364]) assert.equal(by[d], "11 months ago", `${d} days`);
  for (const d of [365, 400, 729]) assert.equal(by[d], "last year", `${d} days`);
  for (const d of [730, 1100]) assert.match(by[d], /^\d+ years ago$/, `${d} days`);
});

test("outside click: listens for pointerdown (touch), not mousedown, and only outside closes the panel", async (t) => {
  const { db, root, signup } = await start(t);
  const a = await signup("sok.dara");
  approve(db, a.id, "hello");
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  assert.deepEqual(bell.listenerTypes(), [], "closed panel holds no document listeners");
  await bell.click();
  assert.ok(bell.listenerTypes().includes("pointerdown"));
  assert.ok(!bell.listenerTypes().includes("mousedown"), "mousedown would miss taps on iOS Safari");

  const panelNode = walk(bell.R.tree).find((el) => el.props?.className === "notif-panel");
  bell.fire("pointerdown", panelNode);
  await bell.settle();
  assert.equal(bell.button().props["aria-expanded"], true, "a tap inside the panel keeps it open");

  bell.fire("pointerdown", { outside: true });
  await bell.settle();
  assert.equal(bell.button().props["aria-expanded"], false);
  assert.deepEqual(bell.listenerTypes(), [], "listeners are removed when the panel closes");
});

test("mark-read reload: a notice newer than the list is listed, and a poll that was in flight cannot undo the result", async (t) => {
  const { db, root, signup, unreadInDb } = await start(t);
  const a = await signup("sok.dara");
  approve(db, a.id, "seen");
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });

  // A poll is held on the wire carrying the old state (1 unread), then the panel opens and a new notice lands meanwhile.
  let first = true;
  bell.holdNext((method) => method === "GET" && first && !(first = false));
  await bell.poll();
  assert.equal(bell.heldCount(), 1);
  approve(db, a.id, "landed while the poll was held");
  await bell.click();
  await bell.releaseAll(); // the stale poll now answers; it must be ignored

  const listed = bell.items().map(textOf).join(" | ");
  assert.match(listed, /landed while the poll was held/, "the panel lists what the badge counts");
  assert.equal(bell.label(), "Notifications, 1 unread");
  assert.equal(unreadInDb(a.id), 1);
  assert.match(bell.live(), /^New notification\. 1 unread\./);
});

test("engines: package.json and README agree on the Node version notify's guard needs", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.equal(pkg.engines.node, ">=22.16");
  assert.equal(lock.packages[""].engines.node, pkg.engines.node);
  assert.match(readme, /Node 22\.16 or newer/);
  assert.doesNotMatch(readme, /22\.13/);
});

test("README states the notify limits and the ignored approval reason", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, new RegExp(`${MESSAGE_MAX} characters \`\(MESSAGE_MAX\)\`|up to ${MESSAGE_MAX} characters`));
  assert.match(readme, new RegExp(`up to ${REASON_MAX}`));
  assert.match(readme, /answer 400/);
  assert.match(readme, /approval is ignored/);
});
