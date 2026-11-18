// No DOM library: the real UsersPage.jsx is bundled with tiny React/module fakes, then the tree is inspected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ROWS = [
  { id: 1, email: "sok.dara@student.cadt.edu.kh", fullName: "Sok Dara", role: "student", createdAt: "2026-01-02 10:00:00" },
  { id: 2, email: "chan.nita@cadt.edu.kh", fullName: "Chan Nita", role: "admin", createdAt: "2026-01-01 10:00:00" },
];

let pageModule;
async function loadPage() {
  if (pageModule) return pageModule;
  const virtual = {
    react: `export const useCallback = (f) => f;
      export const useEffect = () => {};
      export const useMemo = (f) => f();
      export const useState = (v) => {
        const slot = globalThis.__U.slot++;
        if (!(slot in globalThis.__U.state)) globalThis.__U.state[slot] = globalThis.__U.init?.[slot] ?? v;
        const set = (next) => { globalThis.__U.state[slot] = typeof next === "function" ? next(globalThis.__U.state[slot]) : next; };
        return [globalThis.__U.state[slot], set];
      };`,
    "fake/jsx-runtime": `export const jsx = (type, props, key) => ({ type, props, key }); export const jsxs = jsx; export const Fragment = "f";`,
  };
  const fakes = {
    "AuthContext[.]jsx$": "export const useAuth = () => globalThis.__U.auth;",
    "layouts/DashboardLayout[.]jsx$": "export default ({ children }) => children;",
    "components/Icons[.]jsx$": "export const SearchIcon = () => null, UsersIcon = () => null;",
    "users/api[.]js$": `export const listUsers = async () => globalThis.__U.rows;`,
  };
  const result = await build({
    entryPoints: [join(ROOT, "src/pages/UsersPage.jsx")],
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
          for (const source of Object.keys(fakes)) {
            b.onResolve({ filter: new RegExp(source) }, () => ({ path: source, namespace: "v" }));
          }
          b.onLoad({ filter: /.*/, namespace: "v" }, (a) => ({ contents: virtual[a.path] ?? fakes[a.path], loader: "js" }));
        },
      },
    ],
  });
  pageModule = await import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
  return pageModule;
}

function setup(page) {
  globalThis.__U = {
    slot: 0,
    state: { 0: ROWS.map((row) => ({ ...row })), 1: false }, // users, loading
    init: {},
    rows: ROWS,
    auth: { user: ROWS[1] },
  };
  const render = () => {
    globalThis.__U.slot = 0;
    return page.default({});
  };
  return render;
}

function* walk(node) {
  if (Array.isArray(node)) for (const child of node) yield* walk(child);
  else if (node && typeof node === "object") {
    yield node;
    yield* walk(node.props?.children);
  } else if (node != null) yield node;
}
const all = (tree, type) => [...walk(tree)].filter((node) => node.type === type);
const roles = (tree) =>
  all(tree, "span")
    .filter((node) => typeof node.props.className === "string" && node.props.className.startsWith("dash-role"))
    .map((node) => node.props.children);

test("the users page marks each account's role with no role editor", async () => {
  const page = await loadPage();
  const tree = setup(page)();

  assert.equal(all(tree, "tr").length, 3, "a header row and two accounts");
  assert.equal(all(tree, "select").length, 0, "no role picker is rendered");
  assert.equal(all(tree, "button").filter((n) => n.props.children === "Save role").length, 0, "no save button");
  assert.deepEqual(roles(tree), ["Student", "Administrator"], "roles are shown as read-only marks");
});

test("searching narrows the account list without changing the role marks", async () => {
  const page = await loadPage();
  const render = setup(page);
  globalThis.__U.state[3] = "chan";

  const tree = render();
  assert.equal(all(tree, "tr").length, 2, "only the matching account remains");
  assert.deepEqual(roles(tree), ["Administrator"]);
});
