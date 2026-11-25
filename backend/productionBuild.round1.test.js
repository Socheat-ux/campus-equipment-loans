// SCRUM-42 round 1: a shell or host NODE_ENV=development must not leak into the Vite build either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, resolveConfig } from "vite";

const repo = fileURLToPath(new URL("..", import.meta.url));

function setShellNodeEnv(t, value) {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  t.after(() => (saved === undefined ? delete process.env.NODE_ENV : (process.env.NODE_ENV = saved)));
}

test("a shell NODE_ENV=development plus a development .env still gives a production build", async (t) => {
  const dir = mkdtempSync(join(repo, "node_modules", ".scrum42r1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(repo, "vite.config.js"), join(dir, "vite.config.js"));
  mkdirSync(join(dir, "frontend"));
  writeFileSync(join(dir, "frontend", "index.html"), "<!doctype html><title>x</title>");
  cpSync(join(repo, ".env.example"), join(dir, ".env"));
  setShellNodeEnv(t, "development");

  const config = await resolveConfig({ configFile: join(dir, "vite.config.js"), logLevel: "silent" }, "build", "production", "production");
  assert.equal(config.isProduction, true, "the shell NODE_ENV leaked into the build");
});

test("a real vite build with a shell NODE_ENV=development ships no development React or preview routes", async (t) => {
  const outDir = mkdtempSync(join(repo, "node_modules", ".scrum42r1-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  setShellNodeEnv(t, "development");

  await build({ configFile: join(repo, "vite.config.js"), logLevel: "silent", build: { outDir, emptyOutDir: true } });

  const assets = join(outDir, "assets");
  const js = readdirSync(assets).filter((f) => f.endsWith(".js"));
  assert.ok(js.length > 0, "no JS bundle was built");
  for (const f of js) {
    const code = readFileSync(join(assets, f), "utf8");
    assert.ok(!code.includes("/preview/equipment"), `${f} contains the dev-only preview routes`);
    assert.ok(!code.includes("Each child in a list should have a unique"), `${f} contains development React`);
  }
});
