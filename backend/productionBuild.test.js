// SCRUM-42: the root .env is for the server. Its NODE_ENV=development must not turn the Vite build into a development build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";

const repo = fileURLToPath(new URL("..", import.meta.url));

test("a .env with NODE_ENV=development next to vite.config.js still gives a production build", async (t) => {
  // A copy of the real config in a temp folder, with the .env a teammate gets from copying .env.example.
  // Inside node_modules (ignored by git) so the copied config can still import vite.
  const dir = mkdtempSync(join(repo, "node_modules", ".scrum42-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(repo, "vite.config.js"), join(dir, "vite.config.js"));
  mkdirSync(join(dir, "frontend"));
  writeFileSync(join(dir, "frontend", "index.html"), "<!doctype html><title>x</title>");
  cpSync(join(repo, ".env.example"), join(dir, ".env"));

  const saved = process.env.NODE_ENV;
  delete process.env.NODE_ENV; // the build must not depend on the shell either
  t.after(() => (saved === undefined ? delete process.env.NODE_ENV : (process.env.NODE_ENV = saved)));

  const config = await resolveConfig({ configFile: join(dir, "vite.config.js"), logLevel: "silent" }, "build", "production", "production"); // the same call vite build makes
  assert.equal(config.mode, "production");
  assert.equal(config.isProduction, true, "the build would bundle development React");
});
