import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb } from "./db.js";
import { createApp } from "./app.js";

const BASE = "/api/admin/borrow-requests";
const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const hostOffset = new Date().getTimezoneOffset();

// Same job as the helper in the round 2 file. Deleting TZ does not reset the cached zone on Node 24 for Windows, so restore by name.
function useZone(t, zone) {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => (process.env.TZ = saved ?? hostZone));
}

async function start(t) {
  const db = openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const signup = await fetch(`${root}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "Hai.Socheat@cadt.edu.kh", password: "goodpass1" }),
  });
  assert.equal(signup.status, 201);
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run((await signup.json()).user.id);
  db.prepare("UPDATE users SET full_name = 'Hai Socheat' WHERE role = 'admin'").run();
  const cookie = signup.headers.get("set-cookie").split(";")[0];
  const who = Number(db.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES ('Bun.Sarim@student.cadt.edu.kh', 'Bun Sarim', 'student', 'x')").run().lastInsertRowid);
  const item = Number(db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Tripod', 'Lab', 5)").run().lastInsertRowid);
  const addReturned = (returnedAt) =>
    Number(db.prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, status, returned_at) VALUES (?, ?, '2026-11-01', '2026-11-08', 'returned', ?)").run(item, who, returnedAt).lastInsertRowid);
  const exportCsv = async () => {
    const res = await fetch(`${root}${BASE}/export.csv?status=returned`, { headers: { cookie } });
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    return { status: res.status, name: res.headers.get("content-disposition"), lines: text.slice(1).split("\r\n").slice(1, -1) };
  };
  return { addReturned, exportCsv, cookie };
}

const returnedCells = (lines) => Object.fromEntries(lines.map((l) => [Number(l.split(",")[0]), l.split(",")[7]]));

// R3-1a and R3-1b run back to back: the second fails if the first leaves the process in Kiritimati.
test("R3 a zone test switches the process zone", (t) => {
  useZone(t, "Pacific/Kiritimati");
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "Pacific/Kiritimati");
  assert.equal(new Date("2026-11-22T00:00:00Z").getTimezoneOffset(), -840);
});

test("R3 the next test is back in the zone the process started in", () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, hostZone);
  assert.equal(new Date().getTimezoneOffset(), hostOffset);
});

// R3-2: UTC+14 is the far side from Los Angeles; the report must still read Phnom Penh time.
test("R3 returned date and file name are Phnom Penh time when the server runs in Kiritimati", async (t) => {
  useZone(t, "Pacific/Kiritimati");
  const { addReturned, exportCsv } = await start(t);
  const before = addReturned("2026-11-22T16:59:59Z");
  const after = addReturned("2026-11-22T17:00:00Z");
  assert.deepEqual(returnedCells((await exportCsv()).lines), { [before]: "2026-11-22 23:59", [after]: "2026-11-23 00:00" });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-22T16:59:59Z") });
  assert.equal((await exportCsv()).name, 'attachment; filename="borrowing-report-2026-11-22.csv"');
  t.mock.timers.setTime(Date.parse("2026-11-22T17:00:00Z"));
  assert.equal((await exportCsv()).name, 'attachment; filename="borrowing-report-2026-11-23.csv"');
});

// R3-3: a session made on the real clock must survive a mocked clock, and the real clock coming back.
test("R3 the admin session survives a mocked clock and then the real clock", async (t) => {
  const { addReturned, exportCsv } = await start(t);
  addReturned("2026-11-02T03:00:00Z");
  addReturned("2026-11-03T04:30:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 24 * 60 * 60 * 1000 });
  const mocked = await exportCsv();
  t.mock.timers.reset();
  const real = await exportCsv();
  assert.equal(mocked.status, 200);
  assert.equal(real.status, 200);
  assert.equal(mocked.lines.length, 2);
  assert.deepEqual(real.lines, mocked.lines);
});
