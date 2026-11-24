// SCRUM-172: the frontend/, backend/ and shared/ layout. Paths named by the npm scripts must exist, and the static
// route must not serve source from the new folders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { openDb } from "./db.js";
import { createApp } from "./app.js";

const root = new URL("../", import.meta.url);

test("every file the npm scripts and the dev runner name exists, and none points at the old server/ or src/", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const devRunner = readFileSync(new URL("scripts/dev.js", root), "utf8");
  const tokens = Object.values(scripts).join(" ").split(/\s+/).concat([...devRunner.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  // A glob such as backend/*.test.js is checked by its folder.
  const named = tokens.filter((t) => /\.m?js$/.test(t) && !t.startsWith("--")).map((t) => (t.includes("*") ? t.slice(0, t.lastIndexOf("/") + 1) : t));
  assert.ok(named.includes("backend/index.js") && named.includes("backend/seed-dev.js") && named.includes("backend/"), named.join(", "));
  for (const file of named) {
    assert.ok(!/^(server|src)\//.test(file), `${file} still uses the old layout`);
    assert.ok(existsSync(new URL(file, root)), `${file} does not exist`);
  }
  assert.ok(existsSync(new URL("frontend/index.html", root)) && existsSync(new URL("shared/rules.js", root)));
});

// A raw request, because fetch would normalise "/%2e%2e/" into "/" before sending.
const raw = (port, path) =>
  new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("latin1");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    })
      .on("error", reject)
      .end();
  });

test("the static route does not serve files from shared/ or frontend/src/", { skip: !existsSync(new URL("dist", root)) }, async (t) => {
  const server = createApp(openDb(":memory:")).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();
  const paths = [
    "/%2e%2e/shared/rules.js",
    "/..%2fshared%2frules.js",
    "/%2e%2e%5cshared%5crules.js",
    "/%2e%2e/frontend/src/main.jsx",
    "/assets/%2e%2e/%2e%2e/shared/rules.js",
  ];
  for (const path of paths) {
    const res = await raw(port, path);
    for (const secret of ["Pure rules, no Node imports", "export function", "createRoot"]) {
      assert.ok(!res.body.includes(secret), `${path} leaked "${secret}"`);
    }
  }
});
