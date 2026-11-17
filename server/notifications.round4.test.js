// Round 4 review. A seeded random walk over the bell (arrivals, polls, opens, closes, another tab, offline) that checks
// the mark-read reload rule holds in every state, plus one known low-severity gap kept as a todo.
// The UI harness is copied unchanged from notifications.round3-fixes.test.js (real NotificationBell.jsx bundled with
// esbuild, a tiny hooks stand-in, the real API).
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

// ---------- round 4 ----------

// Deterministic pseudo-random numbers, so a failure replays exactly.
function rng(seed) {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}
const badge = (bell) => Number(/(\d+) unread/.exec(bell.label())?.[1] ?? 0);
const isOpen = (bell) => bell.button().props["aria-expanded"] === true;

for (const seed of [31, 20261112, 777, 2026, 9001]) {
  test(`guard: random walk (seed ${seed}) keeps badge, panel and server in step and never marks an unseen notice`, async (t) => {
    const { db, root, call, signup } = await start(t);
    const a = await signup("sok.dara");
    const pick = rng(seed);
    const idOf = new Map(); // message tag -> notification id
    let tag = 0;
    const arrive = (n) => {
      for (let k = 0; k < n; k++) {
        const label = `[[${++tag}]]`;
        idOf.set(label, approve(db, a.id, `notice ${label}`));
      }
    };
    const dbUnread = () => db.prepare("SELECT id FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY id DESC").all(a.id).map((r) => r.id);
    const newest50 = () => db.prepare("SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50").all(a.id).map((r) => r.id);
    const listed = (bell) => bell.items().map((li) => idOf.get(/\[\[\d+\]\]/.exec(textOf(li))[0]));

    let offline = false;
    const hit = { all: 0, ids: 0, reload: 0 }; // proof the walk reached each mark-read path
    arrive(pick(8));
    const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id, offline: () => offline });

    for (let step = 0; step < 150; step++) {
      const where = `seed ${seed} step ${step}`;
      const roll = pick(100);
      if (roll < 25) {
        arrive(pick(5) === 0 ? 20 + pick(40) : 1 + pick(3)); // now and then a burst past the 50-item list
      } else if (roll < 45) {
        await bell.poll();
        if (!offline) assert.equal(badge(bell), dbUnread().length, `${where}: after a good poll the badge is the server's count`);
      } else if (roll < 75) {
        if (isOpen(bell)) {
          // Close three ways: a tap or mouse click on the bell (pointerdown lands inside, then click), outside, or the keyboard.
          const how = pick(3);
          if (how === 0) {
            bell.fire("pointerdown", bell.button());
            await bell.settle();
            assert.ok(isOpen(bell), `${where}: pointerdown on the bell must not close it before the click`);
            await bell.click();
          } else if (how === 1) {
            bell.fire("pointerdown", { outside: true });
            await bell.settle();
          } else {
            await bell.click(); // Enter or Space on the bell: a click with no pointerdown before it
          }
          assert.ok(!isOpen(bell), `${where}: closed (way ${how})`);
          assert.deepEqual(bell.listenerTypes(), [], `${where}: no document listeners while closed`);
          continue;
        }
        const seen = Math.max(0, ...bell.R.hooks[0].v.map((item) => item.id)); // the list the bell holds, shown or not
        const unreadBefore = new Set(dbUnread());
        const sentBefore = bell.sent.length;
        await bell.click();
        assert.ok(isOpen(bell), `${where}: opened`);
        const traffic = bell.sent.slice(sentBefore);
        assert.ok(traffic.filter((r) => r.method === "POST").length <= 1, `${where}: one mark-read per open`);
        assert.ok(traffic.filter((r) => r.method === "GET").length <= 1, `${where}: at most one reload per open`);
        const unreadAfter = new Set(dbUnread());
        for (const id of unreadBefore) {
          if (id > seen) assert.ok(unreadAfter.has(id), `${where}: notice ${id} was marked read before the bell ever listed it`);
        }
        const post = traffic.find((r) => r.method === "POST");
        if (post) {
          hit[post.body.all ? "all" : "ids"]++;
          if (traffic.some((r) => r.method === "GET")) hit.reload++;
          assert.equal(badge(bell), unreadAfter.size, `${where}: after a mark-read the badge is the server's count`);
          const shown = new Set(listed(bell));
          for (const id of newest50()) {
            if (unreadAfter.has(id)) assert.ok(shown.has(id), `${where}: unread notice ${id} is counted but not listed`);
          }
        }
      } else if (roll < 88) {
        // Another tab marks everything up to some id it saw.
        const ids = newest50();
        if (ids.length) {
          const res = await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { all: true, upTo: ids[pick(ids.length)] } });
          assert.equal(res.status, 200);
        }
      } else {
        offline = !offline;
      }
    }
    for (const [path, n] of Object.entries(hit)) assert.ok(n > 0, `seed ${seed} never reached the ${path} path`);
  });
}

// Low severity, not reachable from the bell alone. When notices older than the 50 listed are unread while every listed
// one is read (another client used { ids } on newer ones, for example a future per-item "mark read"), opening the panel
// sends nothing because toggle() returns when no listed item is unread. The badge then shows a count the user can never
// clear. Fix: choose "all" whenever the server's unread count exceeds the unread items listed (unread > ids.length),
// and do not return early while unread > 0.
test("gap: unread notices older than the list can still be cleared by opening the bell", { todo: "low severity, see comment" }, async (t) => {
  const { db, root, call, signup } = await start(t);
  const a = await signup("sok.dara");
  const ids = [];
  for (let k = 1; k <= 55; k++) ids.push(approve(db, a.id, `n${k}`));
  const newest = ids.slice(-50);
  const res = await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { ids: newest } });
  assert.equal(res.status, 200);
  const bell = await mountBell(t, { root, cookie: a.cookie, userId: a.id });
  assert.equal(bell.label(), "Notifications, 5 unread");
  await bell.click();
  await bell.click();
  await bell.click();
  assert.equal(bell.label(), "Notifications", "the badge still counts notices the panel can neither show nor clear");
});
