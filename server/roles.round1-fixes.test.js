// Tests for the round 1 fixes of SCRUM-22 (roles). No DOM library: real source files are bundled with esbuild
// (installed through Vite) against tiny fakes for React, the router and the auth context, then called directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Bundles one source file into a module. `fakes` maps a regex source (matched against the import path) to the code
// that stands in for it. Fake React and the fake JSX runtime come built in.
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
  const patterns = Object.entries(fakes);
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
          for (const [source] of patterns) b.onResolve({ filter: new RegExp(source) }, (a) => ({ path: source, namespace: "v" }));
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
const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------- step 2: a 403 makes the app ask who the user is now ----------

test("equipment api: 403 fires auth-changed, 401 still fires auth-expired, other answers fire nothing", async () => {
  const { createEquipment } = await load("src/equipment/api.js");
  const run = async (status) => {
    events.length = 0;
    globalThis.fetch = reply(status, { error: "x" });
    await createEquipment({}).catch(() => {});
    return [...events];
  };
  assert.deepEqual(await run(403), ["auth-changed"]);
  assert.deepEqual(await run(401), ["auth-expired"]);
  assert.deepEqual(await run(400), []);
  assert.deepEqual(await run(500), []);
  assert.deepEqual(await run(201), []);
});

test("AuthContext: auth-changed reloads /me, auth-expired signs out, and a failed reload keeps the user", async () => {
  const state = { me: Promise.resolve({ user: { role: "admin" } }), calls: [] };
  globalThis.__A = state;
  const { AuthProvider } = await load("src/auth/AuthContext.jsx", {
    "/api[.]js$": `export const api = (path) => { globalThis.__A.calls.push(path); return globalThis.__A.me; };`,
  });
  globalThis.__T = { slot: 0, log: [], effects: [] };
  AuthProvider({ children: null });
  const cleanups = globalThis.__T.effects.map((effect) => effect());
  await tick();
  const userLog = () => globalThis.__T.log.filter(([slot]) => slot === 0).map(([, value]) => value);
  assert.deepEqual(state.calls, ["/me"], "the first load");

  state.me = Promise.resolve({ user: { role: "faculty" } }); // demoted on the server
  window.dispatchEvent(new Event("auth-changed"));
  await tick();
  assert.deepEqual(state.calls, ["/me", "/me"]);
  assert.equal(userLog().at(-1).role, "faculty", "the new role reaches the page guards");

  state.me = Promise.reject(new Error("offline"));
  state.me.catch(() => {});
  const before = userLog().length;
  window.dispatchEvent(new Event("auth-changed"));
  await tick();
  assert.equal(userLog().length, before, "a failed check changes nothing");

  window.dispatchEvent(new Event("auth-expired"));
  assert.equal(userLog().at(-1), null);

  cleanups.forEach((clean) => clean?.());
  const calls = state.calls.length;
  window.dispatchEvent(new Event("auth-changed"));
  assert.equal(state.calls.length, calls, "the listener is removed on unmount");
});

// ---------- real App.jsx, rendered with react-dom/server ----------

// Same idea as roles.round1.test.js: the real App is rendered in a MemoryRouter, with a fake auth context and a
// <Navigate> that prints where it would go. NotAllowedPage and other pages run for real.
let appModule;
async function renderApp(path, auth) {
  if (!appModule) {
    const realRouter = join(ROOT, "node_modules/react-router-dom/dist/index.js").replaceAll("\\", "/");
    const virtual = {
      entry: `import { renderToString } from "react-dom/server.browser";
        import { jsx } from "react/jsx-runtime";
        import { MemoryRouter } from "react-router-dom";
        import App from "./src/App.jsx";
        export const render = (path, auth) => {
          globalThis.__auth = auth;
          return renderToString(jsx(MemoryRouter, { initialEntries: [path], children: jsx(App, {}) }));
        };`,
      auth: "export const useAuth = () => globalThis.__auth;",
      router: `export * from "${realRouter}";
        import { jsx } from "react/jsx-runtime";
        export function Navigate({ to, state }) {
          return jsx("x-nav", { "data-to": String(to), "data-state": JSON.stringify(state ?? null) });
        }`,
    };
    const result = await build({
      entryPoints: ["entry"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      jsx: "automatic",
      logLevel: "silent",
      loader: { ".css": "empty" },
      define: { "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"production"' },
      plugins: [
        {
          name: "fakes",
          setup(b) {
            b.onResolve({ filter: /^entry$/ }, () => ({ path: "entry", namespace: "v" }));
            b.onResolve({ filter: /AuthContext\.jsx$/ }, () => ({ path: "auth", namespace: "v" }));
            b.onResolve({ filter: /^react-router-dom$/ }, () => ({ path: "router", namespace: "v" }));
            b.onLoad({ filter: /.*/, namespace: "v" }, (a) => ({ contents: virtual[a.path], loader: "js", resolveDir: ROOT }));
          },
        },
      ],
    });
    appModule = await import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
  }
  return appModule.render(path, auth);
}

const decode = (s) => s.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
function navOf(html) {
  const m = /<x-nav data-to="([^"]*)" data-state="([^"]*)"/.exec(html);
  return m && { to: decode(m[1]), state: JSON.parse(decode(m[2])) };
}
const USER = { id: 1, fullName: "Sok Dara", email: "sok.dara@student.cadt.edu.kh", role: "student" };
const session = (user, extra = {}) => ({ user, loading: false, logout: async () => {}, ...extra });

// ---------- step 3: the login redirect remembers the whole address ----------

test("a signed-out visitor keeps the query string and hash of the admin page they asked for", async () => {
  for (const path of ["/dashboard?tab=2#top", "/equipment/7/edit?x=1", "/equipment/new#form"]) {
    const nav = navOf(await renderApp(path, session(null)));
    assert.equal(nav.to, "/login", path);
    assert.equal(nav.state.from, path);
  }
});

test("log in and sign up still bounce signed-in users home and show guests the form", async () => {
  for (const path of ["/login", "/signup"]) {
    assert.equal(navOf(await renderApp(path, session(USER)))?.to, "/", `${path} signed in`);
    const guestHtml = await renderApp(path, session(null));
    assert.equal(navOf(guestHtml), null, `${path} guest`);
    assert.match(guestHtml, /<form/);
    assert.match(await renderApp(path, session(null, { loading: true })), /Loading/);
  }
});

// ---------- step 4: safeReturnPath ----------

test("safeReturnPath keeps in-app paths and sends everything else home", async () => {
  const { safeReturnPath } = await import("../src/auth/access.js");
  for (const ok of ["/", "/dashboard", "/equipment/7/edit?tab=2#top", "/a//b", "/a%5Cb"]) {
    assert.equal(safeReturnPath(ok), ok, ok);
  }
  const bad = ["//evil.example", "///evil.example", "/\\evil.example", "/\\/evil.example", "/a\\b", "/\t/evil.example", "/\n/evil.example",
    "/\r/evil.example", "/a\u0000b", "/a\u001fb", "/a\u007fb", "https://evil.example", "javascript:alert(1)", "dashboard", "", " /x", "\\evil"];
  for (const value of [...bad, undefined, null, 42, {}, ["/x"]]) assert.equal(safeReturnPath(value), "/", JSON.stringify(value));
});
