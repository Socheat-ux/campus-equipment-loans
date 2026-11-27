import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";

// Review round 3: a stale lock that cannot be removed used to make openDb spin at full CPU forever.
test("a lock that cannot be taken over is refused with a clear message instead of spinning", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fix3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "app.lock")); // a folder: unlinkSync fails on it, so the takeover can never succeed
  const started = Date.now();
  await assert.rejects(openDb(dir), /Could not take over the stale lock .*app\.lock\. Delete it/);
  assert.ok(Date.now() - started < 5000, "refused at once, not after a long retry loop");
});
