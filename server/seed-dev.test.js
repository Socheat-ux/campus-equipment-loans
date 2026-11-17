import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { seedTestAccounts, SAMPLE_EQUIPMENT, SAMPLE_NOTIFICATIONS, TEST_ACCOUNTS, TEST_PASSWORD } from "./seed-dev.js";

const script = fileURLToPath(new URL("./seed-dev.js", import.meta.url));

test("test accounts can log in with their role, and seeding twice keeps one row each", async (t) => {
  const db = openDb(":memory:");
  await seedTestAccounts(db);
  await seedTestAccounts(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, TEST_ACCOUNTS.length);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM equipment").get().n, SAMPLE_EQUIPMENT.length);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, SAMPLE_NOTIFICATIONS.length);

  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  for (const { email, role } of TEST_ACCOUNTS) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: TEST_PASSWORD }),
    });
    assert.equal(res.status, 200, email);
    assert.equal((await res.json()).user.role, role);
  }
});

test("the script refuses production and creates no database file", () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-dev-"));
  try {
    const path = join(dir, "app.db");
    const run = spawnSync(process.execPath, [script, path], { env: { ...process.env, NODE_ENV: "production" }, encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Refusing/);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
