import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEMO_REQUESTS, seedErrorMessage } from "./seed-demo.js";
import { rejectionReasonError } from "../shared/rules.js";

// Review round 2: a busy live database must read as "try again", never as a raw Postgres error or a stack trace.
test("a lock timeout or a deadlock tells the operator nothing changed and to run it again; other errors keep their message", () => {
  for (const code of ["55P03", "40P01"]) {
    const message = seedErrorMessage(Object.assign(new Error("canceling statement due to lock timeout"), { code }));
    assert.equal(message, "The site was busy, so nothing changed. Run it again in a moment.", code);
  }
  assert.equal(seedErrorMessage(Object.assign(new Error("DEMO_PASSWORD: too short"), { code: "23514" })), "DEMO_PASSWORD: too short");
  assert.equal(seedErrorMessage({ code: "ECONNREFUSED" }), "ECONNREFUSED");
  assert.equal(seedErrorMessage(undefined), "undefined");
});

test("rejection reasons never claim every copy is taken, and each one passes the app's own reason rule", () => {
  for (const r of DEMO_REQUESTS.filter((x) => x.status === "rejected")) {
    assert.equal(rejectionReasonError(r.reason), null, r.reason);
    assert.ok(!/\bboth\b/i.test(r.reason), `"${r.reason}" contradicts the "2 of 2 available" the admin page shows`);
  }
});

test("the README tells the operator that loading signs everyone out and how to get past a refusal", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const paragraph = readme.split("\n").find((line) => line.startsWith("`npm run seed:demo`"));
  assert.ok(paragraph, "the seed:demo paragraph exists");
  for (const phrase of ["signs everyone out", "Supabase SQL editor", "PGDATA_DIR", "site was busy", "trial run the day before"]) {
    assert.ok(paragraph.includes(phrase), phrase);
  }
  assert.equal(paragraph.match(/dates count from the day/gi)?.length ?? 0, 1, "said once, not twice");
  assert.match(readme, /stop `npm run dev:server` before [^.]*`npm run seed:demo`/);
});
