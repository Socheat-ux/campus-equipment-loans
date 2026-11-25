// One-off copy of the old SQLite file (final schema, commit 3b3b4ad) into Postgres: node backend/copy-sqlite.js <path-to-sqlite-file>
// Target: DATABASE_URL if set, else the local PGlite folder the server uses (PGDATA_DIR or data/pgdata).
// The SQLite file is opened read-only. All tables land in one transaction and ids are kept. It only copies into an empty
// target. Once the target has rows, a run inserts nothing and only checks that the rows of the file are there unchanged.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isPostgresUrl, openDb, withTransaction } from "./db.js";

// Copy order follows the foreign keys. conflict is the column that identifies a row, used to find it again in the target.
const TABLES = {
  users: {
    columns: ["id", "email", "full_name", "role", "password_hash", "created_at"],
    conflict: "id",
  },
  sessions: {
    columns: ["token_hash", "user_id", "expires_at"],
    conflict: "token_hash",
  },
  equipment: {
    columns: ["id", "name", "category", "quantity", "available", "asset_id", "location", "created_at", "updated_at"],
    conflict: "id",
    // A NULL shelf count is refilled the way the old startup repair did: total minus approved loans, never below 0.
    select: (cols) =>
      cols
        .map((c) =>
          c === "available"
            ? `COALESCE(available, MAX(0, quantity - (SELECT COUNT(*) FROM borrow_requests r WHERE r.equipment_id = equipment.id AND r.status = 'approved'))) AS available`
            : c,
        )
        .join(", "),
  },
  borrow_requests: {
    columns: ["id", "equipment_id", "user_id", "borrow_date", "return_date", "purpose", "status", "returned_at", "created_at", "decided_by", "decided_at", "decision_reason"],
    conflict: "id",
  },
  notifications: {
    columns: ["id", "user_id", "type", "title", "message", "reason", "request_id", "read_at", "created_at"],
    conflict: "id",
  },
};

// Postgres allows one of these per user and request (index notifications_once); SQLite never had that rule.
const ONCE_TYPES = new Set(["due_soon", "request_submitted"]);
// Before SCRUM-46 a user could hold several pending requests for one item; Postgres allows one (borrow_requests_one_pending).
const DUPLICATE_PENDING_REASON = "Duplicate pending request closed during the move to Postgres";

// pg may hand back numbers, bigints or strings for the same integer, so values are compared as text.
// An empty source asset_id is filled by the equipment_defaults trigger, so any stored value matches it.
const sameValue = (stored, source, fillsBlank) =>
  fillsBlank && source === "" ? true : (stored ?? null) === null ? (source ?? null) === null : String(stored) === String(source);

function missingParts(lite) {
  const problems = [];
  for (const [table, { columns }] of Object.entries(TABLES)) {
    const have = new Set(lite.prepare(`PRAGMA table_info(${table})`).all().map((col) => col.name));
    if (have.size === 0) problems.push(`table ${table}`);
    else for (const col of columns) if (!have.has(col)) problems.push(`column ${table}.${col}`);
  }
  const sql = lite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'borrow_requests'").get()?.sql ?? "";
  if (sql && !sql.includes("'cancelled'")) problems.push("status 'cancelled' in the borrow_requests check");
  return problems;
}

// Returns { users, sessions, equipment, borrow_requests, notifications }, each { copied, skipped }.
// borrow_requests also reports converted: later duplicate pending requests (same user and item) copied as 'cancelled'; the lowest id stays pending.
// skipped is every source row that was not inserted: already in Postgres, or a repeated reminder the new index forbids.
// A target that already has rows in any of the five tables is in use: nothing is inserted (a deleted session or item must
// not come back). The rows are only compared, and the call throws, naming the counts, unless every one is present and equal.
export async function copySqliteToPostgres(sqlitePath, db) {
  if (!existsSync(sqlitePath)) throw new Error(`SQLite file not found: ${sqlitePath}`);
  const lite = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    let problems;
    try {
      problems = missingParts(lite);
    } catch (err) {
      throw new Error(`Cannot read ${sqlitePath} as a SQLite database: ${err.message}`, { cause: err });
    }
    if (problems.length) {
      throw new Error(
        `This SQLite file is not the final schema. Missing: ${problems.join(", ")}. ` +
          "Start the SQLite version once (commit 3b3b4ad) so it upgrades the file, then run the copy again. Nothing was written.",
      );
    }

    const counts = {};
    await withTransaction(db, async (tx) => {
      let inUse = false;
      for (const table of Object.keys(TABLES)) inUse ||= Boolean(await tx.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
      const report = [];
      const different = [];
      let missingTotal = 0;
      for (const [table, spec] of Object.entries(TABLES)) {
        const list = spec.select ? spec.select(spec.columns) : spec.columns.join(", ");
        const rows = lite.prepare(`SELECT ${list} FROM ${table} ORDER BY ${spec.conflict}`).all();
        const insert = tx.prepare(`INSERT INTO ${table} (${spec.columns.join(", ")}) VALUES (${spec.columns.map(() => "?").join(", ")})`);
        const stored = inUse
          ? new Map((await tx.prepare(`SELECT ${spec.columns.join(", ")} FROM ${table}`).all()).map((r) => [String(r[spec.conflict]), r]))
          : null;
        let equal = 0;
        let missing = 0;
        let unequal = 0;
        const seen = new Set();
        let copied = 0;
        let converted = 0;
        for (const row of rows.map((r) => ({ ...r }))) {
          let duplicate = false;
          if (table === "borrow_requests" && row.status === "pending") {
            const key = `${row.user_id}/${row.equipment_id}`;
            duplicate = seen.has(key);
            seen.add(key);
            if (duplicate) Object.assign(row, { status: "cancelled", decision_reason: DUPLICATE_PENDING_REASON });
          }
          if (table === "notifications" && row.request_id !== null && ONCE_TYPES.has(row.type)) {
            const key = `${row.user_id}/${row.request_id}/${row.type}`;
            if (seen.has(key)) continue; // rows come in id order, so the lowest id of the group was kept
            seen.add(key);
          }
          // A session token is a secret, so a session is named by its user.
          const which = row.id !== undefined ? `id ${row.id}` : `user_id ${row.user_id}`;
          if (stored) {
            const there = stored.get(String(row[spec.conflict]));
            if (!there) missing++;
            else if (spec.columns.some((c) => !sameValue(there[c], row[c], table === "equipment" && c === "asset_id"))) {
              unequal++;
              if (different.length < 5) different.push(`Copy failed on ${table} ${which}: a different row already has this id.`);
            } else equal++;
            continue;
          }
          let changes;
          try {
            ({ changes } = await insert.run(...spec.columns.map((c) => row[c])));
          } catch (err) {
            throw new Error(`Copy failed on ${table} ${which}: ${err.message}. Nothing was written.`, { cause: err });
          }
          copied += changes;
          if (duplicate) converted += changes;
        }
        counts[table] = { copied, skipped: rows.length - copied };
        if (table === "borrow_requests") counts[table].converted = converted;
        report.push(`  ${table.padEnd(16)} ${equal} equal, ${missing} missing in the target, ${unequal} different`);
        missingTotal += missing + unequal;
      }
      if (inUse && missingTotal) {
        const lines = [
          "The target database is already in use, so nothing was copied or changed. Rows of the SQLite file compared with it:",
          ...report,
          ...different,
          "Copy into an empty database, or fix the rows named above. Nothing was written.",
        ];
        throw new Error(lines.join("\n"));
      }
      // Inserting explicit ids does not move the identity sequences; without this the next signup would collide.
      // Only after rows were copied: a rerun must not pull a sequence back below ids handed out since.
      for (const [table, spec] of Object.entries(TABLES)) {
        if (spec.conflict === "id" && counts[table].copied > 0) {
          await tx.prepare(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT MAX(id) FROM ${table}))`).get();
        }
      }
    });
    return counts;
  } finally {
    lite.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node backend/copy-sqlite.js <path-to-sqlite-file>");
    process.exit(1);
  }
  if (!existsSync(path)) {
    console.error(`SQLite file not found: ${path}`);
    process.exit(1);
  }
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (databaseUrl && !isPostgresUrl(databaseUrl)) {
    console.error("DATABASE_URL is not a postgres:// or postgresql:// URL, so nothing was copied. Fix it or unset it for the local copy.");
    process.exit(1);
  }
  const folder = process.env.PGDATA_DIR || "data/pgdata";
  let db;
  try {
    db = await openDb(databaseUrl || folder);
    const counts = await copySqliteToPostgres(path, db);
    // The URL holds the database password, so it is never printed.
    console.log(`Copied ${path} into ${databaseUrl ? "DATABASE_URL" : folder}:`);
    for (const [table, { copied, skipped, converted }] of Object.entries(counts)) {
      const note = converted ? `, ${converted} duplicate pending closed as cancelled` : "";
      console.log(`  ${table.padEnd(16)} copied ${copied}, skipped ${skipped}${note}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await db?.close();
  }
}
