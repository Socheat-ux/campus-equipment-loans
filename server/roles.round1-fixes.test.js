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
    "/api\.js$": `export const api = (path) => { globalThis.__A.calls.push(path); return globalThis.__A.me; };`,
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
