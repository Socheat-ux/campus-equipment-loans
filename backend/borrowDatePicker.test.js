// The browser's date picker and the server's validation share one advance-window rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { addDaysISO, BORROW_MAX_ADVANCE_DAYS, todayISO } from "../shared/rules.js";
import { asCard } from "../frontend/src/equipment/cards.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Bundle the real page with fake React so the rendered input props can be inspected without a DOM.
async function loadRequestPage() {
  const virtual = {
    react: `export const useEffect = () => {};
      export const useId = () => "id";
      export const useState = (v) => {
        const U = globalThis.__U, slot = U.slot++;
        if (!(slot in U.init)) U.init[slot] = v;
        if (!(slot in U.state)) U.state[slot] = v;
        return [U.state[slot], (next) => { U.state[slot] = typeof next === "function" ? next(U.state[slot]) : next; }];
      };
      export const useMemo = (f, deps) => {
        const U = globalThis.__U, slot = U.memoSlot++, hit = U.memo[slot];
        if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => Object.is(d, deps[i]))) return hit.value;
        const value = f();
        U.memo[slot] = { deps, value };
        return value;
      };`,
    "fake/jsx-runtime": `export const jsx = (type, props, key) => ({ type, props, key }); export const jsxs = jsx; export const Fragment = "f";`,
    "react-router-dom": `export const Link = "Link"; export const useNavigate = () => () => {}; export const useSearchParams = () => [new URLSearchParams("equipmentId=2")];`,
    StudentHeader: `export default "StudentHeader";`,
    "equipment-api": "export const getEquipment = 0;",
    "requests-api": "export const createBorrowRequest = async () => 0;",
    AuthUI: `export const ErrorText = "ErrorText";`,
  };
  const fakeFor = [
    [/components\/StudentHeader[.]jsx$/, "StudentHeader"],
    [/equipment\/api[.]js$/, "equipment-api"],
    [/borrowRequests\/api[.]js$/, "requests-api"],
    [/auth\/AuthUI[.]jsx$/, "AuthUI"],
  ];
  const result = await build({
    entryPoints: [`${ROOT}frontend/src/pages/BorrowRequestNew.jsx`],
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
          b.onResolve({ filter: /^react$|^fake\/jsx-runtime$|^react-router-dom$/ }, (a) => ({ path: a.path, namespace: "v" }));
          for (const [filter, path] of fakeFor) b.onResolve({ filter }, () => ({ path, namespace: "v" }));
          b.onLoad({ filter: /.*/, namespace: "v" }, (a) => ({ contents: virtual[a.path], loader: "js" }));
        },
      },
    ],
  });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}

function* walk(node) {
  if (Array.isArray(node)) for (const child of node) yield* walk(child);
  else if (node && typeof node === "object") {
    yield node;
    yield* walk(node.props?.children);
  } else if (node != null) yield node;
}

test("the new request date picker offers no date beyond today + BORROW_MAX_ADVANCE_DAYS", async () => {
  const page = await loadRequestPage();
  globalThis.__U = { state: {}, init: {}, memo: [], slot: 0, memoSlot: 0 };
  const draw = () => {
    globalThis.__U.slot = 0;
    globalThis.__U.memoSlot = 0;
    return page.default({});
  };

  draw(); // first render records each state slot's initial value
  const { init, state } = globalThis.__U;
  const itemSlot = Object.keys(init).find((k) => init[k] === null);
  const loadingSlot = Object.keys(init).find((k) => init[k] === true);
  assert.ok(itemSlot !== undefined && loadingSlot !== undefined, "state slots found");
  state[itemSlot] = asCard({ id: 2, name: "Rode mic", category: "Audio", quantity: 2, available: 1 });
  state[loadingSlot] = false;

  const tree = draw();
  const input = [...walk(tree)].find((node) => node.type === "input" && node.props.required);
  assert.ok(input, "borrow date input found");
  const today = todayISO();
  assert.equal(input.props.min, today);
  assert.equal(input.props.max, addDaysISO(today, BORROW_MAX_ADVANCE_DAYS));

  const hint = [...walk(tree)].find((node) => node.type === "p" && node.props.className === "hint");
  assert.match([].concat(hint.props.children).join(""), new RegExp(`up to ${BORROW_MAX_ADVANCE_DAYS} days ahead`));
});
