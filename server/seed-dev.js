// Creates one test account per role for local testing: node server/seed-dev.js [database path]
// The path defaults to DB_PATH or data/app.db, like the server.
// The password below is public, so this refuses to run with NODE_ENV=production.
import { pathToFileURL } from "node:url";
import { openDb, withTransaction } from "./db.js";
import { hashPassword } from "./auth.js";
import { displayName } from "./rules.js";
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
  if (db.prepare("SELECT COUNT(*) AS n FROM equipment").get().n === 0) {
    const insert = db.prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, ?, ?)");
    for (const { name, category, quantity } of SAMPLE_EQUIPMENT) insert.run(name, category, quantity);
  }
  const upsert = db.prepare(
    `INSERT INTO users (email, full_name, role, password_hash) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET role = excluded.role, password_hash = excluded.password_hash`,
  );
  for (const { email, role } of TEST_ACCOUNTS) {
    upsert.run(email, displayName(email), role, await hashPassword(TEST_PASSWORD));
  }
  // Two sample notices for the test student, so the bell has something to show before approvals exist.
  const studentId = db.prepare("SELECT id FROM users WHERE email = ?").get(TEST_ACCOUNTS[0].email).id;
  if (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?").get(studentId).n === 0) {
    withTransaction(db, () => {
      for (const notice of SAMPLE_NOTIFICATIONS) notify(db, { userId: studentId, ...notice });
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2] || process.env.DB_PATH || "data/app.db";
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to create test accounts with NODE_ENV=production.");
    process.exit(1);
  }
  const db = openDb(path);
  await seedTestAccounts(db);
  db.close();
  console.log(`Test accounts in ${path}, password "${TEST_PASSWORD}" (sample equipment and notices added the first time):`);
  for (const { email, role } of TEST_ACCOUNTS) console.log(`  ${role.padEnd(8)} ${email}`);
}
