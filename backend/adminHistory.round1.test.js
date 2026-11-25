import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { csvCell } from "./adminBorrowRequests.js";

const STATUSES = ["pending", "approved", "rejected", "returned", "cancelled"];
const BASE = "/api/admin/borrow-requests";

// Each test gets its own database, an admin cookie and small insert helpers.
async function start(t) {
  const db = await openDb(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await db.close();
  });
  const root = `http://127.0.0.1:${server.address().port}`;

  const signup = await fetch(`${root}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ly.sophea@cadt.edu.kh", password: "goodpass1" }),
  });
  assert.equal(signup.status, 201);
  await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run((await signup.json()).user.id);
  const cookie = signup.headers.get("set-cookie").split(";")[0];

  const addUser = async (email, name, role = "student") =>
    Number(
      (await db.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES (?, ?, ?, 'x') RETURNING id").run(email, name, role))
        .lastInsertRowid,
    );
  const addItem = async (name) =>
    Number((await db.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, 'Lab', 5) RETURNING id").run(name)).lastInsertRowid);
  const insertLoan = db.prepare(
    `INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, status, returned_at)
     VALUES (?, ?, ?, (?::date + 7)::text, ?, ?) RETURNING id`,
  );
  const addLoan = async (itemId, userId, date, status, returnedAt = status === "returned" ? `${date}T09:30:00.000Z` : null) =>
    Number((await insertLoan.run(itemId, userId, date, date, status, returnedAt)).lastInsertRowid);

  const get = (path) => fetch(`${root}${path}`, { headers: { cookie } });
  const list = async (query) => {
    const res = await get(`${BASE}?${query}`);
    return { status: res.status, body: await res.json() };
  };
  const exportCsv = async (query) => {
    const res = await get(`${BASE}/export.csv?${query}`);
    return { res, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer()) };
  };
  // Loan ids the list returns for a query, newest first.
  const listedIds = async (query) => {
    const { status, body } = await list(query);
    assert.equal(status, 200, `${query}: ${JSON.stringify(body)}`);
    return body.requests.map((r) => r.id);
  };
  // The CSV for a query, read the way a spreadsheet would (header row first).
  const exportedRows = async (query) => {
    const { res, text } = await exportCsv(query);
    assert.equal(res.status, 200, query);
    assert.equal(text[0], "﻿");
    return parseCsv(text.slice(1));
  };
  return { db, addUser, addItem, addLoan, list, listedIds, exportCsv, exportedRows };
}

// Splits RFC 4180 text into rows of cells.
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

test("the CSV follows the status filter exactly like the list", async (t) => {
  const { addUser, addItem, addLoan, listedIds, exportedRows } = await start(t);
  const who = await addUser("meas.rithy@student.cadt.edu.kh", "Meas Rithy");
  const item = await addItem("Canon camera");
  for (const [i, status] of STATUSES.entries()) await addLoan(item, who, `2026-10-0${i + 1}`, status);
  await addLoan(item, who, "2026-10-09", "returned");

  for (const query of ["status=returned", "", "status=approved", "status=cancelled&from=2026-10-05"]) {
    const body = (await exportedRows(query)).slice(1);
    const expectedStatus = new URLSearchParams(query).get("status") ?? "pending";
    assert.ok(body.length >= 1, query);
    assert.ok(body.every((row) => row[8] === expectedStatus), query);
    assert.deepEqual(body.map((row) => Number(row[0])), await listedIds(query), query);
  }
  assert.equal((await exportedRows("status=returned")).length, 3);
  assert.equal((await exportedRows("")).length, 2);
});

test("an exclamation mark in a search is literal, even next to a percent sign", async (t) => {
  const { addUser, addItem, addLoan, listedIds, exportedRows } = await start(t);
  const who = await addUser("meas.rithy@student.cadt.edu.kh", "Meas Rithy");
  const ids = [];
  for (const name of ["wid!get", "a!%b", "widget"]) ids.push(await addLoan(await addItem(name), who, "2026-10-01", "pending"));

  assert.deepEqual(await listedIds("item=!"), [ids[1], ids[0]]);
  assert.deepEqual(await listedIds("item=d!g"), [ids[0]]);
  assert.deepEqual(await listedIds(`item=${encodeURIComponent("!%")}`), [ids[1]]);
  assert.deepEqual((await exportedRows("item=d!g")).slice(1).map((row) => Number(row[0])), [ids[0]]);
});

test("the borrower search trims tabs and spaces, ignores case and matches only that person", async (t) => {
  const { addUser, addItem, addLoan, listedIds } = await start(t);
  const item = await addItem("Epson projector");
  const otherItem = await addItem("Canon camera"); // one pending request per person and item, so Sok Dara's second one is for another item
  const dara = await addUser("sok.dara@student.cadt.edu.kh", "Sok Dara");
  const sokha = await addUser("sokha.dara@student.cadt.edu.kh", "Sokha Dara");
  const chan = await addUser("chan.sok@cadt.edu.kh", "Chan Sok", "faculty");
  const first = await addLoan(item, dara, "2026-10-01", "pending");
  await addLoan(item, sokha, "2026-10-02", "pending");
  await addLoan(item, chan, "2026-10-03", "pending");
  const second = await addLoan(otherItem, dara, "2026-10-04", "pending");

  assert.deepEqual(await listedIds("borrower=%09%20SOK.DARA%40%20"), [second, first]);
});

test("control characters in a search are refused for the list and the CSV", async (t) => {
  const { addUser, addItem, addLoan, list, exportCsv } = await start(t);
  await addLoan(await addItem("Epson projector"), await addUser("meas.rithy@student.cadt.edu.kh", "Meas Rithy"), "2026-10-01", "pending");

  const error = { error: "Searches cannot contain control characters." };
  for (const query of ["item=%00", "borrower=%00x", "item=a%7Fb", "item=a%1Fb", "borrower=a%0Ab"]) {
    const res = await list(query);
    assert.equal(res.status, 400, query);
    assert.deepEqual(res.body, error, query);
    const csv = await exportCsv(query);
    assert.equal(csv.res.status, 400, query);
    assert.deepEqual(JSON.parse(csv.text), error, query);
  }
});

test("the CSV shows the returned time in Phnom Penh while the list keeps the ISO string", async (t) => {
  const { addUser, addItem, addLoan, list, exportedRows, exportCsv } = await start(t);
  const who = await addUser("meas.rithy@student.cadt.edu.kh", "Meas Rithy");
  const item = await addItem("Canon camera");
  const late = await addLoan(item, who, "2026-10-25", "returned", "2026-11-01T20:00:00.000Z");
  const early = await addLoan(item, who, "2026-10-26", "returned", "2026-10-31T16:59:00.000Z");
  const open = await addLoan(item, who, "2026-10-27", "approved");

  const rows = await exportedRows("status=all");
  assert.equal(rows[0][7], "Returned date");
  const byId = Object.fromEntries(rows.slice(1).map((row) => [Number(row[0]), row[7]]));
  assert.deepEqual(byId, { [late]: "2026-11-02 03:00", [early]: "2026-10-31 23:59", [open]: "" });

  const iso = Object.fromEntries((await list("status=all")).body.requests.map((r) => [r.id, r.returnedAt]));
  assert.deepEqual(iso, { [late]: "2026-11-01T20:00:00.000Z", [early]: "2026-10-31T16:59:00.000Z", [open]: null });

  // The file name carries the Phnom Penh date; both clock reads are allowed in case midnight passes mid-test.
  const phnomPenhDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Phnom_Penh" }).format(new Date());
  const before = phnomPenhDate();
  const disposition = (await exportCsv("")).res.headers.get("content-disposition");
  const after = phnomPenhDate();
  assert.ok(
    [before, after].some((day) => disposition === `attachment; filename="borrowing-report-${day}.csv"`),
    disposition,
  );
});

test("a 3000-row export is complete, in order, spreadsheet-safe and fast", async (t) => {
  const { addUser, addItem, addLoan, listedIds, exportCsv } = await start(t);
  const people = [];
  for (const [email, name] of [
    ["sok.dara@student.cadt.edu.kh", "Sok, Dara"],
    ["chan.nita@student.cadt.edu.kh", 'Chan "Nita" Keo'],
    ["keo.bopha@student.cadt.edu.kh", "Keo\nBopha"],
    ["meas.rithy@student.cadt.edu.kh", '=Meas, "Rithy"\r\nX'],
    ["chhim.vanna@student.cadt.edu.kh", "+Chhim Vanna"],
  ])
    people.push(await addUser(email, name));
  const items = [];
  for (const name of ["Dell laptop", "=cmd item", "Epson projector"]) items.push(await addItem(name));
  // The database allows one pending request per person and item, so a repeat of a pending pair is stored as approved.
  const pendingPairs = new Set();
  for (let i = 0; i < 3000; i += 1) {
    const day = String((i % 28) + 1).padStart(2, "0");
    let status = STATUSES[i % 5];
    if (status === "pending") {
      const pair = `${i % 3}:${i % 5}`;
      if (pendingPairs.has(pair)) status = "approved";
      pendingPairs.add(pair);
    }
    await addLoan(items[i % 3], people[i % 5], `2026-10-${day}`, status);
  }

  const started = performance.now();
  const { res, text } = await exportCsv("status=all");
  const elapsed = performance.now() - started;
  assert.equal(res.status, 200);
  assert.ok(elapsed < 10000, `export took ${Math.round(elapsed)} ms`);

  const rows = parseCsv(text.slice(1));
  assert.equal(rows.length, 3001);
  assert.ok(rows.every((row) => row.length === 9));
  const ids = rows.slice(1).map((row) => Number(row[0]));
  assert.ok(ids.every((id, i) => i === 0 || id < ids[i - 1]));
  assert.deepEqual(ids, await listedIds("status=all"));
  for (const row of rows.slice(1)) {
    assert.ok(!/^[=+\-@]/.test(row[1]) && !/^[=+\-@]/.test(row[3]), row.join("|"));
  }
  assert.ok(rows.some((row) => row[3] === `'=Meas, "Rithy"\r\nX`));
  assert.ok(rows.some((row) => row[1] === "'=cmd item"));
});

test("csvCell defuses full-width and hidden-prefix formulas and leaves plain values alone", () => {
  for (const input of [" =1", " =1", "​=1", "﻿=1", "＝1+1", "＋1", "－1", "＠x"]) {
    assert.equal(csvCell(input), `'${input}`, JSON.stringify(input));
  }
  for (const [input, output] of [["a=b", "a=b"], ["2026-11-01", "2026-11-01"], ["Sok Dara", "Sok Dara"], [42, "42"]]) {
    assert.equal(csvCell(input), output, JSON.stringify(input));
  }
});
