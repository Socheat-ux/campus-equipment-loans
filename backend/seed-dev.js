// Creates one test account per role for local testing: node backend/seed-dev.js [database path] [--remote]
// DATABASE_URL wins, then the path (a PGlite folder), then PGDATA_DIR or data/pgdata, like the server.
// The password below is public, so this refuses to run with NODE_ENV=production, and with DATABASE_URL set unless --remote is given.
import { pathToFileURL } from "node:url";
import { isPostgresUrl, openDb, withTransaction } from "./db.js";
import { hashPassword } from "./auth.js";
import { addDaysISO, displayName, todayISO } from "../shared/rules.js";
import { notify } from "./notifications.js";

export const TEST_PASSWORD = "testpass123";
export const TEST_ACCOUNTS = [
  { email: "test.student@student.cadt.edu.kh", role: "student" },
  { email: "test.faculty@cadt.edu.kh", role: "faculty" },
  { email: "test.admin@cadt.edu.kh", role: "admin" },
];

// A few items so the catalogue is not empty on a fresh database. One has quantity 0 to show "out of stock".
export const SAMPLE_EQUIPMENT = [
  { name: "Dell Latitude 5440 Laptop", category: "Laptop", quantity: 5 },
  { name: "Epson EB-X49 Projector", category: "Projector", quantity: 2 },
  { name: "Canon EOS 250D Camera", category: "Camera", quantity: 1 },
  { name: "Rode Wireless GO II Microphone", category: "Audio", quantity: 0 },
  { name: "Arduino Uno Starter Kit", category: "Lab", quantity: 8 },
];

export const SAMPLE_NOTIFICATIONS = [
  { type: "request_approved", message: "Your request for the Epson EB-X49 Projector was approved." },
  {
    type: "request_rejected",
    message: "Your request for the Canon EOS 250D Camera was rejected.",
    reason: "The camera is booked for the media club that week. Please pick another date.",
  },
];

// Running it again resets the password and role, so the accounts always match this file.
// Sample equipment is only added to an empty catalogue, so real items are never duplicated.
export async function seedTestAccounts(db) {
  if ((await db.prepare("SELECT COUNT(*)::int AS n FROM equipment").get()).n === 0) {
    const insert = db.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, ?, ?)");
    for (const { name, category, quantity } of SAMPLE_EQUIPMENT) await insert.run(name, category, quantity);
  }
  const upsert = db.prepare(
    `INSERT INTO users (email, full_name, role, password_hash) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET role = excluded.role, password_hash = excluded.password_hash`,
  );
  for (const { email, role } of TEST_ACCOUNTS) {
    await upsert.run(email, displayName(email), role, await hashPassword(TEST_PASSWORD));
  }
  // One clearly marked approved loan gives the admin dashboard an overdue row to demonstrate.
  const studentId = (await db.prepare("SELECT id FROM users WHERE email = ?").get(TEST_ACCOUNTS[0].email)).id;
  const demoPurpose = "DEMO: overdue loan sample";
  const exists = await db.prepare("SELECT 1 FROM borrow_requests WHERE user_id = ? AND purpose = ?").get(studentId, demoPurpose);
  const laptop = await db.prepare("SELECT id, available FROM equipment WHERE name = 'Dell Latitude 5440 Laptop' ORDER BY id LIMIT 1").get();
  if (!exists && laptop?.available > 0) {
    const today = todayISO();
    await withTransaction(db, async (tx) => {
      await tx.prepare("UPDATE equipment SET available = available - 1 WHERE id = ?").run(laptop.id);
      await tx.prepare("INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, purpose, status) VALUES (?, ?, ?, ?, ?, 'approved')")
        .run(laptop.id, studentId, addDaysISO(today, -14), addDaysISO(today, -7), demoPurpose);
    });
  }
  // Two sample notices for the test student, so the bell has something to show before approvals exist.
  if ((await db.prepare("SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ?").get(studentId)).n === 0) {
    await withTransaction(db, async (tx) => {
      for (const notice of SAMPLE_NOTIFICATIONS) await notify(tx, { userId: studentId, ...notice });
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const path = args.find((arg) => !arg.startsWith("--"));
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to create test accounts with NODE_ENV=production.");
    process.exit(1);
  }
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (databaseUrl && !isPostgresUrl(databaseUrl)) {
    console.error("DATABASE_URL is not a postgres:// or postgresql:// URL, so nothing was done. Fix it or unset it for the local copy.");
    process.exit(1);
  }
  // A .env that points at the live database must not receive accounts with a public password by accident.
  if (databaseUrl && !args.includes("--remote")) {
    console.error("Refusing to create test accounts: DATABASE_URL is set, so this would write to that database. Pass --remote to do it anyway, or unset DATABASE_URL for the local copy.");
    process.exit(1);
  }
  let db;
  try {
    db = await openDb(databaseUrl || path || process.env.PGDATA_DIR || "data/pgdata");
  } catch (err) {
    console.error(err.message || err.code || err); // e.g. the local folder is in use by dev:server
    process.exit(1);
  }
  await seedTestAccounts(db);
  await db.close();
  // The URL holds the database password, so it is never printed.
  const where = databaseUrl ? "DATABASE_URL" : path || process.env.PGDATA_DIR || "data/pgdata";
  console.log(`Test accounts in ${where}, password "${TEST_PASSWORD}" (sample equipment and notices added the first time):`);
  for (const { email, role } of TEST_ACCOUNTS) console.log(`  ${role.padEnd(8)} ${email}`);
}
