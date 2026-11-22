import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// With TZ set but empty, Node on Windows uses the host zone. A zone helper that restores with `??` writes "" back and turns the zone into UTC.
// So run the real round 2 and round 3 files that way: their own "back in the zone" checks fail if a helper regresses.
// Inside node --test, NODE_TEST_CONTEXT hides a nested run's failures from the exit code, so drop it.
const { NODE_TEST_CONTEXT, ...env } = process.env;

for (const file of ["adminHistory.round2.test.js", "adminHistory.round3.test.js"]) {
  test(`${file} passes when TZ is set but empty`, () => {
    const run = spawnSync(process.execPath, ["--test", fileURLToPath(new URL(`./${file}`, import.meta.url))], {
      env: { ...env, TZ: "" },
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  });
}
