import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { csvCell } from "./adminBorrowRequests.js";

const GOOD = "goodpass1";

// Seeded history: three borrowers, four items (two with LIKE wildcards in the name) and every status.
const PEOPLE = [
  ["sok.dara@student.cadt.edu.kh", "Sok Dara", "student"],
  ["chan.nita@cadt.edu.kh", "Chan Nita", "faculty"],
  ["keo.bopha@student.cadt.edu.kh", "+Keo, \"Bopha\"", "student"],
];
const ITEMS = ["Dell Latitude laptop", "Epson projector", "50% off kit", "=HYPERLINK(\"http://x\")"];
// [borrower index, item index, borrow date, status]
const LOANS = [
  [0, 0, "2026-10-01", "returned"],
  [0, 1, "2026-10-15", "approved"],
  [1, 0, "2026-10-31", "rejected"],
  [1, 2, "2026-11-01", "returned"],
  [2, 3, "2026-11-05", "cancelled"],
  [2, 0, "2026-11-20", "pending"],
  [0, 2, "2026-11-30", "pending"],
];

async function start(t) {
  const db = openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;

  const signup = await fetch(`${root}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "lov.kimtech@cadt.edu.kh", password: GOOD }),
  });
  assert.equal(signup.status, 201);
  const adminId = (await signup.json()).user.id;
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminId);
  const cookie = signup.headers.get("set-cookie").split(";")[0];

  const userIds = PEOPLE.map(([email, name, role]) =>
    Number(db.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES (?, ?, ?, 'x')").run(email, name, role).lastInsertRowid),
  );
  const itemIds = ITEMS.map((name) =>
    Number(db.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Lab', 5)").run(name).lastInsertRowid),
  );
  const loanIds = LOANS.map(([who, what, date, status]) =>
    Number(
      db
        .prepare(
          `INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, status, returned_at)
           VALUES (?, ?, ?, date(?, '+7 days'), ?, ?)`,
        )
        .run(itemIds[what], userIds[who], date, date, status, status === "returned" ? `${date}T09:30:00.000Z` : null).lastInsertRowid,
    ),
  );

  const get = (path) => fetch(`${root}${path}`, { headers: { cookie } });
  const list = async (query) => {
    const res = await get(`/api/admin/borrow-requests?${query}`);
    return { status: res.status, body: await res.json() };
  };
  // Seed positions of the rows a query returns, newest first, so each assertion reads against LOANS above.
  const positions = async (query) => {
    const { status, body } = await list(query);
    assert.equal(status, 200, `${query}: ${JSON.stringify(body)}`);
    return body.requests.map((r) => loanIds.indexOf(r.id));
  };
  return { get, list, positions, itemIds };
}

test("returned loans can be listed, all statuses together, and no status still means pending", async (t) => {
  const { list, positions } = await start(t);
  assert.deepEqual(await positions("status=returned"), [3, 0]);
  assert.deepEqual(await positions("status=all"), [6, 5, 4, 3, 2, 1, 0]);
  assert.deepEqual(await positions(""), [6, 5]);

  const returned = (await list("status=returned")).body.requests[0];
  assert.equal(returned.returnedAt, "2026-11-01T09:30:00.000Z");
  assert.equal(returned.requesterEmail, "chan.nita@cadt.edu.kh");
  // Tab counts cover every request whatever the filters, and now include returned.
  assert.deepEqual((await list("status=all&borrower=nobody")).body.counts, {
    pending: 2,
    approved: 1,
    rejected: 1,
    returned: 2,
    cancelled: 1,
  });
});

test("the borrow date range is inclusive at both ends and works with either end alone", async (t) => {
  const { positions } = await start(t);
  assert.deepEqual(await positions("status=all&from=2026-10-31&to=2026-11-05"), [4, 3, 2]);
  assert.deepEqual(await positions("status=all&from=2026-11-20"), [6, 5]);
  assert.deepEqual(await positions("status=all&to=2026-10-01"), [0]);
  assert.deepEqual(await positions("status=all&from=2026-11-06&to=2026-11-19"), []);
});

test("item search matches part of the name or the asset ID, ignores case, and treats % and _ literally", async (t) => {
  const { positions, itemIds } = await start(t);
  assert.deepEqual(await positions("status=all&item=LATITUDE"), [5, 2, 0]);
  assert.deepEqual(await positions(`status=all&item=CG-${String(itemIds[1]).padStart(4, "0")}`), [1]);
  assert.deepEqual(await positions(`status=all&item=${encodeURIComponent("50%")}`), [6, 3]);
  assert.deepEqual(await positions(`status=all&item=${encodeURIComponent("%")}`), [6, 3]);
  assert.deepEqual(await positions("status=all&item=_"), []);
  assert.deepEqual(await positions("status=all&item=%20%20epson%20%20"), [1]);
});

test("borrower search matches part of the full name or the email", async (t) => {
  const { positions } = await start(t);
  assert.deepEqual(await positions("status=all&borrower=sok%20dara"), [6, 1, 0]);
  assert.deepEqual(await positions("status=all&borrower=chan.nita@"), [3, 2]);
  assert.deepEqual(await positions("status=all&borrower=%40student.cadt.edu.kh"), [6, 5, 4, 1, 0]);
});

test("all filters together narrow to the one matching loan", async (t) => {
  const { positions } = await start(t);
  assert.deepEqual(await positions("status=returned&from=2026-10-01&to=2026-10-31&item=dell&borrower=sok"), [0]);
  assert.deepEqual(await positions("status=pending&from=2026-10-01&to=2026-10-31&item=dell&borrower=sok"), []);
});

test("bad filters get a 400 with a message that says what to fix", async (t) => {
  const { list } = await start(t);
  const cases = [
    ["status=done", "Status must be pending, approved, rejected, returned, cancelled or all."],
    ["status=pending&status=approved", "Use status once."],
    ["item=a&item=b", "Use item once."],
    ["borrower[x]=1", "Use borrower once."],
    ["from=2026-02-30", "From must be a date like 2026-11-01."],
    ["from=1%2F11%2F2026", "From must be a date like 2026-11-01."],
    ["to=tomorrow", "To must be a date like 2026-11-30."],
    ["from=2026-11-02&to=2026-11-01", "From must be on or before To."],
    [`item=${"x".repeat(101)}`, "Searches must be 100 characters or fewer."],
    [`borrower=${"x".repeat(101)}`, "Searches must be 100 characters or fewer."],
  ];
  for (const [query, error] of cases) {
    const res = await list(query);
    assert.equal(res.status, 400, query);
    assert.deepEqual(res.body, { error }, query);
  }
  assert.equal((await list(`item=${"x".repeat(100)}`)).status, 200);
});

// Splits RFC 4180 text into rows of cells, so the test reads the file the way a spreadsheet would.
function parseCsv(text) {
  const rows = [[]];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), (i += 1);
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") rows.at(-1).push(cell), (cell = "");
    else if (ch === "\r" && text[i + 1] === "\n") rows.at(-1).push(cell), (cell = ""), rows.push([]), (i += 1);
    else cell += ch;
  }
  rows.pop(); // the file ends with a line break
  return rows;
}

test("the CSV holds exactly the filtered rows with every column, as a UTF-8 download", async (t) => {
  const { get, list } = await start(t);
  const query = "status=all&from=2026-10-01&to=2026-11-05&borrower=a";
  const res = await get(`/api/admin/borrow-requests/export.csv?${query}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(res.headers.get("content-disposition"), /^attachment; filename="borrowing-report-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
  assert.equal(text[0], "﻿");
  assert.ok(text.endsWith("\r\n"));

  const [header, ...rows] = parseCsv(text.slice(1));
  assert.deepEqual(header, ["Request ID", "Item", "Asset ID", "Borrower", "Email", "Borrow date", "Due date", "Returned at", "Status"]);
  const listed = (await list(query)).body.requests;
  assert.equal(rows.length, listed.length);
  assert.ok(rows.length >= 4);
  rows.forEach((row, i) => {
    const r = listed[i];
    assert.deepEqual(row, [
      String(r.id),
      csvCell(r.equipmentName).replace(/^"|"$/g, "").replace(/""/g, '"'),
      r.equipmentAssetId,
      csvCell(r.requesterName).replace(/^"|"$/g, "").replace(/""/g, '"'),
      r.requesterEmail,
      r.borrowDate,
      r.returnDate,
      r.returnedAt ?? "",
      r.status,
    ]);
  });
  // Names keep Southeast Asian order, and dangerous first characters are defused.
  assert.ok(rows.some((row) => row[3] === "Sok Dara"));
  assert.ok(rows.some((row) => row[1] === "'=HYPERLINK(\"http://x\")"));
  assert.ok(rows.some((row) => row[3] === "'+Keo, \"Bopha\""));
});

test("the CSV refuses the same bad filters and an empty result is just the header", async (t) => {
  const { get } = await start(t);
  const bad = await get("/api/admin/borrow-requests/export.csv?from=2026-13-01");
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "From must be a date like 2026-11-01." });

  const empty = await get("/api/admin/borrow-requests/export.csv?status=all&borrower=nobody");
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), "Request ID,Item,Asset ID,Borrower,Email,Borrow date,Due date,Returned at,Status\r\n");
});

test("csvCell defuses formulas and quotes only what needs quoting", () => {
  const cases = [
    [null, ""],
    [undefined, ""],
    [42, "42"],
    ["plain", "plain"],
    ["=1+1", "'=1+1"],
    ["+855", "'+855"],
    ["-2", "'-2"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tcmd", "'\tcmd"],
    ["\rcmd", "\"'\rcmd\""],
    ["a,b", "\"a,b\""],
    ["say \"hi\"", "\"say \"\"hi\"\"\""],
    ["line\nbreak", "\"line\nbreak\""],
    ["a=b", "a=b"],
    ["2026-11-01", "2026-11-01"],
  ];
  for (const [input, output] of cases) assert.equal(csvCell(input), output, JSON.stringify(input));
});
