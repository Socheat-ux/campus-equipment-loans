// Round 1 review of SCRUM-22 (restricting pages by role). Tests named DEFECT fail until the defect is fixed;
// the rest guard behaviour that works today. No DOM library: the real App.jsx and HomePage.jsx are bundled with
// esbuild (installed through Vite) and rendered with react-dom/server inside a MemoryRouter. <Navigate> is swapped
// for a marker element so the test can see where a page would send the user and with what router state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { ROLES } from "./rules.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GOOD = "goodpass1";
const ADMIN_PAGES = ["/dashboard", "/equipment/new", "/equipment/7/edit"];
const USERS = {
  student: { id: 1, fullName: "Sok Dara", email: "sok.dara@student.cadt.edu.kh", role: "student" },
  faculty: { id: 2, fullName: "Keo Bopha", email: "keo.bopha@cadt.edu.kh", role: "faculty" },
  admin: { id: 3, fullName: "Chan Nita", email: "chan.nita@cadt.edu.kh", role: "admin" },
};

// ---------- bundle the real pages ----------

const bundles = {};
async function loadPages(dev) {
  if (bundles[dev]) return bundles[dev];
  const realRouter = join(ROOT, "node_modules/react-router-dom/dist/index.js").replaceAll("\\", "/");
  const virtual = {
    entry: `import { renderToString } from "react-dom/server.browser";
      import { jsx } from "react/jsx-runtime";
      import { MemoryRouter } from "react-router-dom";
      import App from "./src/App.jsx";
      export { default as App } from "./src/App.jsx";
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
    define: { "import.meta.env.DEV": String(dev), "process.env.NODE_ENV": '"production"' },
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
  const dir = mkdtempSync(join(tmpdir(), "roles-r1-"));
  const file = join(dir, `pages-${dev}.mjs`);
  writeFileSync(file, result.outputFiles[0].text);
  bundles[dev] = await import(pathToFileURL(file).href);
  rmSync(dir, { recursive: true, force: true });
  return bundles[dev];
}

const decode = (s) => s.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
function navOf(html) {
  const m = /<x-nav data-to="([^"]*)" data-state="([^"]*)"/.exec(html);
  return m && { to: decode(m[1]), state: JSON.parse(decode(m[2])) };
}
const signedIn = (who) => ({ user: USERS[who], loading: false, logout: async () => {} });
const guest = { user: null, loading: false, logout: async () => {} };
const DENIED = "have access to this page";

// ---------- client pages ----------

test("a signed-out visitor on any admin page is sent to /login, remembering that exact page", async () => {
  const { render } = await loadPages(false);
  for (const path of [...ADMIN_PAGES, "/equipment/%2F%2Fevil.example/edit", "/DASHBOARD", "/dashboard/"]) {
    const html = render(path, guest);
    const nav = navOf(html);
    assert.equal(nav?.to, "/login", path);
    assert.ok(nav.state.from.startsWith("/") && !nav.state.from.startsWith("//"), `${path} -> ${nav.state.from}`);
    assert.equal(nav.state.from.toLowerCase().replace(/\/$/, ""), path.toLowerCase().replace(/\/$/, ""), path);
    assert.ok(!html.includes("dash-") && !html.includes("<form"), `${path} leaked page content`);
  }
});

test("students and faculty get the not-allowed page with no admin content, for every admin page", async () => {
  const { render } = await loadPages(false);
  for (const who of ["student", "faculty"]) {
    for (const path of ADMIN_PAGES) {
      const html = render(path, signedIn(who));
      assert.equal(navOf(html), null, `${who} ${path} redirected instead of explaining`);
      assert.match(html, new RegExp(DENIED), `${who} ${path}`);
      assert.equal(html.match(/<h1/g)?.length, 1, "exactly one h1");
      assert.ok(html.indexOf("<main") < html.indexOf("<h1"), "the heading sits inside the main landmark");
      assert.match(html, /<a [^>]*href="\/"[^>]*>Back to the Catalog<\/a>/);
      assert.match(html, / is for administrators\. You are signed in as (Sok Dara|Keo Bopha)/);
      for (const leak of ["dash-", "<form", "Add equipment", "Save"]) assert.ok(!html.includes(leak), `${who} ${path} shows ${leak}`);
    }
  }
});

test("administrators open every admin page, and the legacy /equipment link still lands on the dashboard", async () => {
  const { render } = await loadPages(false);
  for (const path of ADMIN_PAGES) {
    const html = render(path, signedIn("admin"));
    assert.equal(navOf(html), null, path);
    assert.ok(!html.includes(DENIED), path);
  }
  assert.match(render("/dashboard", signedIn("admin")), /dash-sidebar/);
  assert.equal(navOf(render("/equipment", signedIn("student")))?.to, "/dashboard");
});

test("while the session is still loading, no admin page shows content or redirects", async () => {
  const { render } = await loadPages(false);
  for (const path of ADMIN_PAGES) {
    const html = render(path, { user: null, loading: true, logout: async () => {} });
    assert.equal(navOf(html), null, path);
    assert.match(html, /Loading/);
    assert.ok(!html.includes("dash-") && !html.includes(DENIED), path);
  }
});

test("design previews exist only in development; a production build sends them home", async () => {
  const prod = await loadPages(false);
  const dev = await loadPages(true);
  for (const path of ["/preview/equipment", "/preview/equipment/new", "/preview/equipment/edit"]) {
    for (const who of [guest, signedIn("student")]) {
      assert.equal(navOf(prod.render(path, who))?.to, "/", `prod ${path}`);
      assert.equal(navOf(dev.render(path, who)), null, `dev ${path}`);
    }
  }
});

// Static net for the next teammate: every client route must be public on purpose, a redirect, or behind a gate.
test("every client route in App.jsx is listed as public, is a redirect, or is wrapped in Gate/RoleGate", async () => {
  const PUBLIC = new Set(["/"]);
  const DEV_ONLY = new Set(["/preview/equipment", "/preview/equipment/new", "/preview/equipment/edit"]);
  for (const dev of [false, true]) {
    const { App } = await loadPages(dev);
    const routes = [App().props.children].flat(Infinity).filter(Boolean);
    assert.ok(routes.length >= 7, "found the routes");
    for (const { props } of routes) {
      const kind = (props.element.type.name ?? "").replace(/\d+$/, "");
      const ok = PUBLIC.has(props.path) || (dev && DEV_ONLY.has(props.path)) || ["Gate", "RoleGate", "Navigate"].includes(kind);
      assert.ok(ok, `route ${props.path} renders <${kind}> with no gate: wrap it or add it to PUBLIC on purpose`);
    }
  }
});

test("the catalogue header shows the Dashboard link to administrators only", async () => {
  const { render } = await loadPages(false);
  const dash = /href="\/dashboard"/;
  assert.doesNotMatch(render("/", guest), dash);
  assert.doesNotMatch(render("/", signedIn("student")), dash);
  assert.doesNotMatch(render("/", signedIn("faculty")), dash);
  assert.match(render("/", signedIn("admin")), dash);
  for (const who of ["student", "faculty"]) assert.doesNotMatch(render("/", signedIn(who)), /href="\/equipment\//);
});

// ---------- the login return path ----------

// Bundles the real Login.jsx against tiny fakes so its submit handler can run. Returns where it navigated.
let loginModule;
async function loginTarget(from) {
  if (!loginModule) {
    const virtual = {
      react: `export const useId = () => "id"; export const useState = (v) => globalThis.__L.state(v);`,
      "react-dom": "export const flushSync = (f) => f();",
      "fake/jsx-runtime": "export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx; export const Fragment = 'f';",
      router: `export const Link = () => null;
        export const useLocation = () => ({ state: globalThis.__L.routerState });
        export const useNavigate = () => (to, opts) => globalThis.__L.went.push(to);`,
      auth: "export const useAuth = () => ({ login: async () => {} });",
      ui: "export const AuthShell = () => null, Field = () => null, PasswordField = () => null, ErrorText = () => null, SuccessText = () => null;",
    };
    const result = await build({
      entryPoints: [join(ROOT, "src/pages/Login.jsx")],
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
            b.onResolve({ filter: /^react$|^react-dom$|^fake\/jsx-runtime$/ }, (a) => ({ path: a.path, namespace: "v" }));
            b.onResolve({ filter: /^react-router-dom$/ }, () => ({ path: "router", namespace: "v" }));
            b.onResolve({ filter: /AuthContext\.jsx$/ }, () => ({ path: "auth", namespace: "v" }));
            b.onResolve({ filter: /AuthUI\.jsx$/ }, () => ({ path: "ui", namespace: "v" }));
            b.onLoad({ filter: /.*/, namespace: "v" }, (a) => ({ contents: virtual[a.path], loader: "js" }));
          },
        },
      ],
    });
    loginModule = await import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
  }
  const values = ["chan.nita@cadt.edu.kh", GOOD, "", false]; // email, password, error, busy
  let i = 0;
  globalThis.__L = { routerState: from === undefined ? undefined : { from }, went: [], state: () => [values[i++ % 4], () => {}] };
  const tree = loginModule.default();
  const form = [tree.props.children].flat().find((n) => n?.type === "form");
  await form.props.onSubmit({ preventDefault() {} });
  return globalThis.__L.went;
}

test("signing in returns to the remembered in-app page, and falls back home for anything else", async () => {
  assert.deepEqual(await loginTarget("/dashboard"), ["/dashboard"]);
  assert.deepEqual(await loginTarget("/equipment/7/edit"), ["/equipment/7/edit"]);
  for (const bad of [undefined, null, 42, { pathname: "/dashboard" }, "", "dashboard", "//evil.example", "https://evil.example/x"]) {
    assert.deepEqual(await loginTarget(bad), ["/"], JSON.stringify(bad));
  }
});

// "/\evil.example" is read by browsers as "//evil.example". RoleGate cannot produce it today, but the guard's comment
// promises "never //other.site", and the next person to feed it a ?next= value will trust that.
test("DEFECT (low): the login return guard lets a backslash path through, which browsers treat as another site", async () => {
  for (const bad of ["/\\evil.example", "/\\/evil.example", "/\t/evil.example"]) {
    assert.deepEqual(await loginTarget(bad), ["/"], JSON.stringify(bad));
  }
});

// ---------- server ----------

async function startServer(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  return (method, path, cookie, body) =>
    fetch(`${root}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

test("a role change takes effect on the very next request, with the same session cookie", async (t) => {
  const db = openDb(":memory:");
  const call = await startServer(t, createApp(db));
  const res = await call("POST", "/api/auth/signup", undefined, { email: "chan.nita@cadt.edu.kh", password: GOOD });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const item = { name: "Tripod", category: "Camera", quantity: 2 };
  const setRole = (role) => db.prepare("UPDATE users SET role = ? WHERE email = 'chan.nita@cadt.edu.kh'").run(role);

  assert.equal((await call("POST", "/api/equipment", cookie, item)).status, 403, "faculty first");
  setRole("admin");
  assert.equal((await call("POST", "/api/equipment", cookie, item)).status, 201, "promoted");
  assert.equal((await (await call("GET", "/api/auth/me", cookie)).json()).user.role, "admin");
  setRole("faculty");
  assert.equal((await call("PUT", "/api/equipment/1", cookie, item)).status, 403, "demoted mid-session");
  assert.equal((await (await call("GET", "/api/auth/me", cookie)).json()).user.role, "faculty");
  db.prepare("DELETE FROM users").run();
  assert.equal((await call("POST", "/api/equipment", cookie, item)).status, 401, "deleted account");
});

test("admin-only API answers 401/403 for every write verb and odd path, before reading the body", async (t) => {
  const db = openDb(":memory:");
  const call = await startServer(t, createApp(db));
  const res = await call("POST", "/api/auth/signup", undefined, { email: "sok.dara@student.cadt.edu.kh", password: GOOD });
  const student = res.headers.get("set-cookie").split(";")[0];
  for (const [method, path] of [["POST", "/api/equipment"], ["PUT", "/api/equipment/1"], ["PATCH", "/api/equipment/1"],
    ["DELETE", "/api/equipment/1"], ["POST", "/api/equipment/"], ["PUT", "/api/EQUIPMENT/1"], ["POST", "/api/equipment/1/../"]]) {
    assert.equal((await call(method, path, undefined, { name: "x" })).status, 401, `guest ${method} ${path}`);
    assert.equal((await call(method, path, student, { name: "x" })).status, 403, `student ${method} ${path}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM equipment").get().n, 0);
});

test("ROLES matches the users table CHECK constraint exactly", () => {
  const db = openDb(":memory:");
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get().sql;
  const inCheck = /role\s+TEXT[^,]*CHECK\s*\(\s*role\s+IN\s*\(([^)]*)\)/i.exec(sql)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual([...inCheck].sort(), [...ROLES].sort());
});

// The count check in roles.test.js only counts routes inside mounted routers. A route written straight on the app,
// such as app.get("/api/health", ...) or app.post("/api/admin/reset", ...), is reachable but never counted, so the
// README promise "The test fails until you do" does not hold. This test pulls the real counter out of roles.test.js.
test("DEFECT: the route-count check misses an /api route added directly on the app", async (t) => {
  const src = readFileSync(join(ROOT, "server/roles.test.js"), "utf8");
  const fn = /function countRouterRoutes[\s\S]*?\n}\n/.exec(src)?.[0];
  assert.ok(fn, "countRouterRoutes moved: import it here instead");
  const countRouterRoutes = new Function(`${fn}; return countRouterRoutes;`)();

  const db = openDb(":memory:");
  const app = createApp(db);
  const before = countRouterRoutes(app._router.stack);
  // Same place a teammate would write it in server/app.js: above the /api not-found handler.
  app.post("/api/admin/reset", (req, res) => res.json({ reset: true }));
  const stack = app._router.stack;
  const added = stack.pop();
  const notFound = stack.findIndex((l) => !l.route && !l.handle.stack && l.regexp.test("/api/x") && !l.regexp.test("/other"));
  stack.splice(notFound, 0, added);

  const call = await startServer(t, app);
  assert.equal((await call("POST", "/api/admin/reset")).status, 200, "the new route is live and open to guests");
  assert.equal(countRouterRoutes(app._router.stack), before + 1, "the count check should notice the new API route");
});
