// Tests for the round 2 fixes of SCRUM-22 (roles). No DOM library: real source files are bundled with esbuild
// against tiny fakes for React, the router and the auth context, then called directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Bundles one source file with fake React (hooks read and write globalThis.__T) and the given fakes, keyed by import regex.
// A slot listed in __T.init starts with that value instead, so a test can fill in a form.
async function load(file, fakes = {}) {
  const virtual = {
    react: `export const createContext = () => ({ Provider: "Provider" });
      export const useContext = () => globalThis.__T.auth;
      export const useId = () => "id";
      export const useRef = () => ({ current: null });
      export const useCallback = (f) => f;
      export const useMemo = (f) => f();
      export const useState = (v) => { const slot = globalThis.__T.slot++; return [globalThis.__T.init?.[slot] ?? v, () => {}]; };
      export const useEffect = () => {};`,
    "fake/jsx-runtime": `export const jsx = (type, props, key) => ({ type, props, key }); export const jsxs = jsx; export const Fragment = "f";`,
  };
  const result = await build({
    entryPoints: [join(ROOT, file)],
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

// Every element and string in a rendered tree, in order.
function* walk(node) {
  if (Array.isArray(node)) for (const child of node) yield* walk(child);
  else if (node && typeof node === "object") {
    yield node;
    yield* walk(node.props?.children);
  } else if (node != null) yield node;
}
const fresh = (extra = {}) => (globalThis.__T = { slot: 0, ...extra });

// ---------- step 4: the home page names the role in plain words ----------

test("home page shows 'Administrator' / 'Faculty' / 'Student', never the raw role value", async () => {
  const home = await load("src/pages/HomePage.jsx", {
    "AuthContext[.]jsx$": "export const useAuth = () => globalThis.__T.auth;",
    "equipment/api[.]js$": "export const listEquipment = async () => [];",
    "NotificationBell[.]jsx$": `export default "NotificationBell";`,
    "^react-router-dom$": `export const Link = "Link";`,
  });
  for (const [role, shown] of [["admin", "Administrator"], ["faculty", "Faculty"], ["student", "Student"]]) {
    fresh({ auth: { user: { fullName: "Sok Dara", role }, logout: async () => {} } });
    const small = [...walk(home.default())].find((n) => n.type === "small");
    assert.equal(small.props.children, shown);
  }
});

// ---------- step 5: each blocked page gets a fresh "not allowed" page ----------

test("App: the not-allowed page is keyed by pathname, so two blocked pages do not share one instance", async () => {
  const app = await load("src/App.jsx", {
    "AuthContext[.]jsx$": "export const useAuth = () => globalThis.__T.auth;",
    "pages/(Login|Signup|HomePage|EquipmentAdd|EquipmentEdit|EquipmentDashboard)[.]jsx$": `export default "Page";`,
    "pages/NotAllowedPage[.]jsx$": `export default "NotAllowedPage";`,
    "equipment/previewData[.]js$": "export const PREVIEW_EQUIPMENT = [], PREVIEW_USER = {};",
    "^react-router-dom$": `export const Routes = "Routes", Route = "Route", Navigate = "Navigate";
      export const useLocation = () => globalThis.__T.location;`,
  });
  const gate = (path) => {
    const route = [...walk(app.default())].find((n) => n.type === "Route" && n.props.path === path);
    return route.props.element.type(route.props.element.props); // RoleGate: render it by hand
  };
  const blocked = (path) => {
    fresh({ auth: { user: { role: "student" }, loading: false }, location: { pathname: path, search: "", hash: "" } });
    return gate(path);
  };
  const dashboard = blocked("/dashboard");
  const add = blocked("/equipment/new");
  assert.equal(dashboard.type, "NotAllowedPage");
  assert.equal(dashboard.key, "/dashboard");
  assert.notEqual(dashboard.key, add.key, "same key on two blocked pages: React would reuse the old one and skip the announcement");
});

// ---------- step 6: sign-up keeps the remembered page, like log-in ----------

const router = (from) => `export const Link = "Link";
  export const useNavigate = () => globalThis.__T.navigate;
  export const useLocation = () => ({ state: ${JSON.stringify(from === undefined ? null : { from })} });`;
const authFakes = {
  "AuthContext[.]jsx$": "export const useAuth = () => globalThis.__T.auth;",
  "AuthUI[.]jsx$": `export const AuthShell = "AuthShell", Field = "Field", PasswordField = "PasswordField", ErrorText = "ErrorText";`,
  "^react-dom$": "export const flushSync = (f) => f();",
};

test("login page: the 'Create an account' link carries the remembered page", async () => {
  const login = await load("src/pages/Login.jsx", { ...authFakes, "^react-router-dom$": router("/dashboard") });
  fresh({ auth: {}, navigate() {} });
  const link = [...walk(login.default())].find((n) => n.type === "Link" && n.props.to === "/signup");
  assert.deepEqual(link.props.state, { from: "/dashboard" });
});

test("signup returns to the remembered page after sign-up, and to '/' when it is missing or leaves the app", async () => {
  for (const [from, expected] of [["/equipment/new?x=1", "/equipment/new?x=1"], [undefined, "/"], ["//evil.example", "/"], ["/\\evil.example", "/"]]) {
    const signup = await load("src/pages/Signup.jsx", { ...authFakes, "^react-router-dom$": router(from) });
    const calls = [];
    // useState slots: email, password, confirm
    fresh({
      auth: { signup: async () => {} },
      navigate: (...args) => calls.push(args),
      init: ["sok.dara@student.cadt.edu.kh", "goodpass1", "goodpass1"],
    });
    const form = [...walk(signup.default())].find((n) => n.type === "form");
    await form.props.onSubmit({ preventDefault() {} });
    assert.deepEqual(calls, [[expected, { replace: true }]], `from ${from}`);
  }
});
