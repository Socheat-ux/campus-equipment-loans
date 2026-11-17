// Round 2 review tests for SCRUM-22 (roles). New angles only: event loops between the two api modules, stale /me
// answers racing a sign-out, React StrictMode double effects, a fuzzed return-path guard checked with the WHATWG URL
// parser browsers use, route shapes the count check still misses, and expired or deleted admin sessions.
// Tests named DEFECT fail on purpose until the defect is fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import express from "express";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { safeReturnPath } from "../src/auth/access.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const realFetch = globalThis.fetch; // the client tests below replace fetch with fakes

// Bundles one source file with fake React (hooks write to globalThis.__T) and any extra fakes, keyed by import regex.
async function load(file, fakes = {}) {
  const virtual = {
    react: `export const createContext = () => ({ Provider: "Provider" });
      export const useContext = () => globalThis.__T.auth;
      export const useId = () => "id";
      export const useRef = () => ({ current: null });
      export const useState = (v) => { const slot = globalThis.__T.slot++; return [v, (x) => globalThis.__T.log.push([slot, x])]; };
      export const useEffect = (f) => globalThis.__T.effects.push(f);`,
    "fake/jsx-runtime": `export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx; export const Fragment = "f";`,
  };
  const result = await build({
    entryPoints: [join(ROOT, file)],
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
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}

globalThis.window = new EventTarget();
const events = [];
for (const name of ["auth-expired", "auth-changed"]) window.addEventListener(name, () => events.push(name));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

// ---------- no event loop between the two api modules ----------

test("the /me reload cannot loop: the auth api never fires auth-changed, and each equipment 403 fires exactly once", async () => {
  const auth = await load("src/auth/api.js");
  const equipment = await load("src/equipment/api.js");

  // /me is what the auth-changed handler calls. Whatever it answers, it must not fire auth-changed again.
  for (const status of [403, 401, 500]) {
    events.length = 0;
    globalThis.fetch = async () => ({ ok: false, status, json: async () => ({ error: "x" }) });
    await assert.rejects(auth.api("/me"), (err) => err.status === status);
    assert.ok(!events.includes("auth-changed"), `auth api ${status} fired auth-changed`);
  }

  // Five parallel admin calls rejected at once: five events and five rejections, no retries hidden in the client.
  events.length = 0;
  let fetches = 0;
  globalThis.fetch = async () => (fetches++, { ok: false, status: 403, json: async () => ({ error: "Administrators only." }) });
  const results = await Promise.allSettled([
    equipment.createEquipment({}),
    equipment.updateEquipment(1, {}),
    equipment.updateEquipment(2, {}),
    equipment.getEquipment(3),
    equipment.listEquipment(),
  ]);
  assert.equal(fetches, 5, "no retry");
  assert.deepEqual(events, Array(5).fill("auth-changed"));
  assert.ok(results.every((r) => r.status === "rejected" && r.reason.status === 403 && r.reason.message === "Administrators only."));
});

// ---------- AuthContext: answers that arrive late or say "signed out" ----------

async function provider() {
  const state = { calls: [], answers: [] };
  globalThis.__A = state;
  const mod = await load("src/auth/AuthContext.jsx", {
    "/api[.]js$": `export const api = (path) => {
      globalThis.__A.calls.push(path);
      const next = globalThis.__A.answers.shift();
      return next ? next.promise : Promise.resolve(path === "/me" ? { user: { id: 1, role: "admin" } } : null);
    };`,
  });
  globalThis.__T = { slot: 0, log: [], effects: [] };
  const element = mod.AuthProvider({ children: null });
  const cleanups = globalThis.__T.effects.map((effect) => effect());
  await tick();
  const users = () => globalThis.__T.log.filter(([slot]) => slot === 0).map(([, value]) => value);
  return { state, value: element.props.value, users, done: () => cleanups.forEach((clean) => clean?.()) };
}

test("DEFECT (low): a /me reload that answers after the user signed out puts the old user back on screen", async (t) => {
  const p = await provider();
  t.after(p.done);
  const slow = deferred();
  p.state.answers.push(slow); // the reload fired by a 403 is slow
  window.dispatchEvent(new Event("auth-changed"));
  await p.value.logout(); // meanwhile the user signs out
  assert.equal(p.users().at(-1), null, "signed out");
  slow.resolve({ user: { id: 1, role: "admin" } }); // the server answered before the sign-out, the reply lands after it
  await tick();
  assert.equal(p.users().at(-1), null, "a stale /me answer must not sign the user back in on screen");
});

test("DEFECT (low): a /me reload that answers 401 keeps showing the old user instead of signing out", async (t) => {
  const p = await provider();
  t.after(p.done);
  const gone = deferred();
  p.state.answers.push(gone);
  window.dispatchEvent(new Event("auth-changed"));
  gone.reject(Object.assign(new Error("Not logged in."), { status: 401 }));
  await tick();
  assert.equal(p.users().at(-1), null, "401 from /me means no session: only an unreachable server should keep the user");
});

// ---------- NotAllowedPage under React StrictMode ----------

test("NotAllowedPage survives StrictMode's mount, unmount, mount: right title while shown, original title after", async () => {
  const page = await load("src/pages/NotAllowedPage.jsx", {
    "AuthContext[.]jsx$": "export const useAuth = () => globalThis.__T.auth;",
    "AuthUI[.]jsx$": `export const AuthShell = "AuthShell", ErrorText = "ErrorText";`,
    "^react-router-dom$": `export const Link = "Link"; export const useNavigate = () => () => {};
      export const useLocation = () => ({ pathname: "/dashboard", search: "", hash: "" });`,
  });
  globalThis.__T = { slot: 0, log: [], effects: [], auth: { user: { fullName: "Sok Dara", role: "student" }, logout: async () => {} } };
  globalThis.document = { title: "Equipment · Campus Equipment Loans" };
  const shell = page.default({ roles: ["admin"] });
  const focused = [];
  shell.props.headingRef.current = { focus: () => focused.push(document.title) };
  const [effect] = globalThis.__T.effects;

  const first = effect(); // StrictMode: mount
  first(); // StrictMode: simulated unmount
  assert.equal(document.title, "Equipment · Campus Equipment Loans");
  const second = effect(); // StrictMode: mount again
  assert.equal(document.title, "Not allowed · Campus Equipment Loans", "not left with the restored title");
  assert.deepEqual(focused, Array(2).fill("Not allowed · Campus Equipment Loans"));
  second(); // real unmount
  assert.equal(document.title, "Equipment · Campus Equipment Loans", "never restores 'Not allowed' as the old title");
});

// ---------- safeReturnPath, fuzzed against the URL parser browsers use ----------

test("safeReturnPath: no accepted value leaves the site, for 30,000 random tricky strings", () => {
  const BASE = "https://loans.cadt.example/login";
  const parts = ["/", "/", "\\", "%2F", "%2f", "%5C", "%09", ".", "..", "@", ":", "?", "#", " ", "\t", "\n", "\r", "\u0000",
    "\u007f", "\u0085", " ", "　", "／", "∕", "﹨", "evil.example", "http:", "javascript:", "a"];
  let seed = 22;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let i = 0; i < 30000; i++) {
    let value = rand(3) ? "/" : "";
    for (let j = rand(8); j >= 0; j--) value += parts[rand(parts.length)];
    const out = safeReturnPath(value);
    assert.ok(out === value || out === "/", JSON.stringify(value));
    const url = new URL(out, BASE);
    assert.equal(url.origin, "https://loans.cadt.example", `${JSON.stringify(value)} left the site as ${url.href}`);
  }
});

test("safeReturnPath keeps odd but harmless in-app paths, including huge ones, and returns fast", () => {
  for (const ok of ["/%2F%2Fevil.example", "/%5C%5Cevil.example", "/..//evil.example", "/／／evil.example", "/ünï/コード",
    "/login", "/signup?from=%2F%2Fx", "/a\u0085b"]) {
    assert.equal(safeReturnPath(ok), ok, JSON.stringify(ok));
  }
  const huge = "/" + "a/".repeat(500_000);
  const started = performance.now();
  assert.equal(safeReturnPath(huge), huge);
  assert.equal(safeReturnPath(huge + "\\"), "/", "a backslash at the very end of a long value is still caught");
  assert.ok(performance.now() - started < 200, "no slow regex on long input");
});

// ---------- route shapes the count check still misses ----------

test("DEFECT (low): the route-count check misses an /api endpoint written as plain middleware or as a mounted sub-app", async () => {
  const src = readFileSync(join(ROOT, "server/roles.test.js"), "utf8");
  const fn = /function countRouterRoutes[\s\S]*?\n}\n/.exec(src)?.[0];
  assert.ok(fn, "countRouterRoutes moved: import it here instead");
  const countRouterRoutes = new Function(`${fn}; return countRouterRoutes;`)();

  const shapes = {
    "app.use('/api/health', handler)": (app) => app.use("/api/health", (req, res) => res.json({ ok: true })),
    "app.use('/api/v2', subApp)": (app) => {
      const sub = express();
      sub.post("/reset", (req, res) => res.json({ reset: true }));
      app.use("/api/v2", sub);
    },
    "app.get(['/api/a', '/api/b'], handler)": (app) => app.get(["/api/a", "/api/b"], (req, res) => res.json({})),
  };
  const missed = [];
  for (const [name, add] of Object.entries(shapes)) {
    const app = createApp(openDb(":memory:"));
    const before = countRouterRoutes(app._router.stack);
    add(app);
    if (countRouterRoutes(app._router.stack) === before) missed.push(name);
  }
  assert.deepEqual(missed, [], "each of these is a live, unprotected /api endpoint that ROUTES never has to list");
});

// ---------- expired and deleted admin sessions are signed-out, not forbidden ----------

test("an expired or deleted administrator session gets 401 (sign in again), never 403 or 500", async (t) => {
  const db = openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie) =>
    realFetch(root + path, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie && { cookie }) }, body: JSON.stringify(body) });
  const signup = async (email) => (await post("/api/auth/signup", { email, password: "goodpass1" })).headers.get("set-cookie").split(";")[0];
  const item = { name: "Tripod", category: "Camera", quantity: 2 };

  const expiring = await signup("chan.nita@cadt.edu.kh");
  db.prepare("UPDATE users SET role = 'admin' WHERE email = 'chan.nita@cadt.edu.kh'").run();
  assert.equal((await post("/api/equipment", item, expiring)).status, 201, "admin works first");
  db.prepare("UPDATE sessions SET expires_at = ?").run(Date.now() - 1);
  const expired = await post("/api/equipment", item, expiring);
  assert.equal(expired.status, 401);
  assert.deepEqual(await expired.json(), { error: "Please log in." });

  const deleted = await signup("keo.bopha@cadt.edu.kh");
  db.prepare("UPDATE users SET role = 'admin' WHERE email = 'keo.bopha@cadt.edu.kh'").run();
  db.prepare("DELETE FROM users WHERE email = 'keo.bopha@cadt.edu.kh'").run();
  assert.equal((await post("/api/equipment", item, deleted)).status, 401, "a deleted account is signed out");
  assert.equal((await post("/api/equipment", item, "sid=" + "x".repeat(4000))).status, 401, "a junk cookie is signed out");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM equipment").get().n, 1, "only the first write landed");
});
