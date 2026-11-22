import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The child runs with TZ set but empty, which Node on Windows reads as "use the host zone".
// Writing "" back after a zone switch would turn the zone into Etc/Unknown (UTC), so the helper must fall back to the host zone.
const CHILD = `
import { test } from "node:test";
import assert from "node:assert/strict";

const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const startDay = new Date(2026, 10, 22).toISOString();

test("an empty TZ is restored to the starting zone", () => {
  assert.equal(process.env.TZ, "");
  const saved = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati";
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "Pacific/Kiritimati");
  process.env.TZ = saved || hostZone;
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, hostZone);
  assert.equal(new Date(2026, 10, 22).toISOString(), startDay);
});
`;

test("the zone helper restores the starting zone when TZ is set but empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "tz-empty-"));
  try {
    const file = join(dir, "empty-tz.test.mjs");
    writeFileSync(file, CHILD);
    // Inside node --test, NODE_TEST_CONTEXT makes a nested run hide its failures from the exit code, so drop it.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const run = spawnSync(process.execPath, ["--test", file], { env: { ...env, TZ: "" }, encoding: "utf8" });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
