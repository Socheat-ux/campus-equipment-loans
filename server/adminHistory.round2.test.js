import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { csvCell } from "./adminBorrowRequests.js";

const BASE = "/api/admin/borrow-requests";

const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Runs the test as if the server sat in another time zone, and puts the real one back afterwards.
// Deleting TZ does not reset the cached zone on Node 24 for Windows, so an unset TZ is restored to the host zone by name.
function useZone(t, zone) {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => (process.env.TZ = saved || hostZone));
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
    body: JSON.stringify({ email: "ly.sophea@cadt.edu.kh", password: "goodpass1" }),
  });
  assert.equal(signup.status, 201);
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run((await signup.json()).user.id);
  const cookie = signup.headers.get("set-cookie").split(";")[0];
  const who = Number(db.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES ('meas.rithy@student.cadt.edu.kh', 'Meas Rithy', 'student', 'x')").run().lastInsertRowid);
  const item = Number(db.prepare("INSERT INTO equipment (name, category, quantity) VALUES ('Canon camera', 'Lab', 5)").run().lastInsertRowid);
  const addReturned = (returnedAt) =>
    Number(db.prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, status, returned_at) VALUES (?, ?, '2026-11-01', '2026-11-08', 'returned', ?)").run(item, who, returnedAt).lastInsertRowid);
  const get = (path, method = "GET") => fetch(`${root}${path}`, { method, headers: { cookie } });
  const csvText = async (query) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(await (await get(`${BASE}/export.csv?${query}`)).arrayBuffer());
  return { db, addReturned, get, csvText };
}

// R2-1: the server zone must not leak in. Run with a far-away zone so reverting timeZone fails even on a Phnom Penh laptop.
test("R2 returned time is Phnom Penh even when the server runs in Los Angeles, and midnight is 00:00", async (t) => {
  useZone(t, "America/Los_Angeles");
  const { addReturned, csvText } = await start(t);
  const midnight = addReturned("2026-11-22T17:00:00.000Z");
  const lastMinute = addReturned("2026-12-31T16:59:00.000Z");
  const newYear = addReturned("2026-12-31T17:00:00.000Z");
  const text = await csvText("status=returned");
  const cells = Object.fromEntries(text.slice(1).split("\r\n").slice(1, -1).map((line) => [Number(line.split(",")[0]), line.split(",")[7]]));
  assert.deepEqual(cells, { [midnight]: "2026-11-23 00:00", [lastMinute]: "2026-12-31 23:59", [newYear]: "2027-01-01 00:00" });
});

// R2-2: the file date follows the Phnom Penh calendar at the day boundary, with a fixed clock instead of the real one.
test("R2 the file name date flips at Phnom Penh midnight, not UTC or server midnight", async (t) => {
  useZone(t, "America/Los_Angeles");
  const { get } = await start(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-22T16:59:59.000Z") });
  const name = async () => (await get(`${BASE}/export.csv`)).headers.get("content-disposition");
  assert.equal(await name(), 'attachment; filename="borrowing-report-2026-11-22.csv"');
  t.mock.timers.setTime(Date.parse("2026-11-22T17:00:00.000Z"));
  assert.equal(await name(), 'attachment; filename="borrowing-report-2026-11-23.csv"');
});

test("R2 the next test is back in the zone the process started in", () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, hostZone);
});

// R2-3: the guard leaves hyphens, spaces and equals signs inside ordinary text alone, and it composes with RFC 4180 quoting.
test("R2 csvCell does not over-escape and still quotes a guarded cell", () => {
  for (const plain of ["   ", "A-1", "Room 3-204", "e=mc2", "x@y"]) assert.equal(csvCell(plain), plain, JSON.stringify(plain));
  assert.equal(csvCell('-"x",y'), `"'-""x"",y"`);
  assert.equal(csvCell("\n=1"), `"'\n=1"`);
  assert.equal(csvCell("\u3000=1"), "'\u3000=1");
});

// R2-4: a stored returned_at that is not a date is passed through, and the formula guard still applies to it.
test("R2 an unparsable returned_at is kept as text in the CSV and still defused", async (t) => {
  const { addReturned, csvText } = await start(t);
  const formula = addReturned("=HYPERLINK(1)");
  const junk = addReturned("2026-13-45T99:00:00Z");
  const lines = (await csvText("status=returned")).slice(1).split("\r\n");
  const cells = Object.fromEntries(lines.slice(1, -1).map((line) => [Number(line.split(",")[0]), line.split(",")[7]]));
  assert.deepEqual(cells, { [formula]: "'=HYPERLINK(1)", [junk]: "2026-13-45T99:00:00Z" });
});

// R2-5: HEAD on the export sends the download headers without a body, and a bad filter is still a 400.
test("R2 HEAD on the export gives the headers only and refuses bad filters", async (t) => {
  const { addReturned, get } = await start(t);
  addReturned("2026-11-02T03:00:00.000Z");
  const ok = await get(`${BASE}/export.csv?status=returned`, "HEAD");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(ok.headers.get("content-disposition"), /^attachment; filename="borrowing-report-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal((await ok.arrayBuffer()).byteLength, 0);
  const bad = await get(`${BASE}/export.csv?item=a%00b`, "HEAD");
  assert.equal(bad.status, 400);
});
