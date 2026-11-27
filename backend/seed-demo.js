// Loads the demo data for screenshots, the run guide and the presentation: npm run seed:demo [database path] [--remote]
// DATABASE_URL wins, then the path (a PGlite folder), then PGDATA_DIR or data/pgdata, like the server.
// Every demo account uses DEMO_PASSWORD from .env, so no password is written in the repo.
// It empties the database and loads the same data again, so it only runs when every account is a demo or test account.
import { pathToFileURL } from "node:url";
import { isPostgresUrl, openDb, withTransaction } from "./db.js";
import { hashPassword } from "./auth.js";
import { notify, notifyAdmins } from "./notifications.js";
import { TEST_ACCOUNTS, TEST_PASSWORD } from "./seed-dev.js";
import { addDaysISO, displayName, passwordError, todayISO } from "../shared/rules.js";

// Family name first, as in the email (LastName.FirstName); displayName keeps that order.
export const DEMO_ACCOUNTS = [
  { email: "chan.sokha@cadt.edu.kh", role: "admin" },
  { email: "pich.sopheap@cadt.edu.kh", role: "admin" },
  { email: "keo.sophal@cadt.edu.kh", role: "faculty" },
  { email: "heng.bopha@cadt.edu.kh", role: "faculty" },
  { email: "sok.dara@student.cadt.edu.kh", role: "student" },
  { email: "chea.vanna@student.cadt.edu.kh", role: "student" },
  { email: "ly.sreymom@student.cadt.edu.kh", role: "student" },
  { email: "phan.rithy@student.cadt.edu.kh", role: "student" },
  { email: "noun.sovann@student.cadt.edu.kh", role: "student" },
];

// The Canon camera ends with every copy on loan, and the microphone has none at all.
export const DEMO_EQUIPMENT = [
  { name: "Dell Latitude 5440 Laptop", category: "Laptop", quantity: 5 },
  { name: "MacBook Air M2", category: "Laptop", quantity: 2 },
  { name: "Epson EB-X49 Projector", category: "Projector", quantity: 2 },
  { name: "Canon EOS 250D Camera", category: "Camera", quantity: 1 },
  { name: "Sony ZV-E10 Camera", category: "Camera", quantity: 2 },
  { name: "Rode Wireless GO II Microphone", category: "Audio", quantity: 0 },
  { name: "JBL Charge 5 Speaker", category: "Audio", quantity: 3 },
  { name: "TP-Link Archer AX55 Router", category: "Networking", quantity: 2 },
  { name: "Arduino Uno Starter Kit", category: "Lab", quantity: 8 },
  { name: "HDMI Cable 3 m", category: "Accessories", quantity: 10 },
];

// Days are relative to the day the seed runs (Cambodia time), so overdue stays overdue and due today stays today.
// from and to are the borrow and return dates; returned is the day it came back; by is the deciding admin.
export const DEMO_REQUESTS = [
  { who: "sok.dara", item: "Epson EB-X49 Projector", from: 1, to: 4, status: "pending", purpose: "Group presentation for the database course" },
  { who: "chea.vanna", item: "MacBook Air M2", from: 0, to: 2, status: "pending", purpose: "Editing the club video, starting today" },
  { who: "keo.sophal", item: "Sony ZV-E10 Camera", from: 3, to: 8, status: "pending", purpose: "Recording guest lectures" },
  { who: "ly.sreymom", item: "Dell Latitude 5440 Laptop", from: -2, to: 5, status: "approved", by: "chan.sokha", purpose: "Programming assignment" },
  { who: "phan.rithy", item: "Canon EOS 250D Camera", from: -1, to: 4, status: "approved", by: "pich.sopheap", purpose: "Photos for the campus open day" },
  { who: "heng.bopha", item: "Epson EB-X49 Projector", from: -3, to: 2, status: "approved", by: "chan.sokha", purpose: "Workshop in room B204" },
  { who: "noun.sovann", item: "Arduino Uno Starter Kit", from: -6, to: 0, status: "approved", by: "chan.sokha", purpose: "IoT lab project, due back today" },
  { who: "sok.dara", item: "Dell Latitude 5440 Laptop", from: -10, to: -3, status: "approved", by: "pich.sopheap", purpose: "Capstone prototype" },
  { who: "chea.vanna", item: "JBL Charge 5 Speaker", from: -9, to: -2, status: "approved", by: "chan.sokha", purpose: "Student council event" },
  {
    who: "phan.rithy", item: "MacBook Air M2", from: 2, to: 5, status: "rejected", by: "chan.sokha", purpose: "Design homework",
    reason: "Both MacBooks are booked for the design workshop that week. Please choose a Dell laptop instead.",
  },
  {
    who: "noun.sovann", item: "Rode Wireless GO II Microphone", from: 1, to: 3, status: "rejected", by: "pich.sopheap", purpose: "Podcast recording",
    reason: "The microphone is out for repair. Please choose another audio item.",
  },
  { who: "ly.sreymom", item: "TP-Link Archer AX55 Router", from: 2, to: 4, status: "cancelled", purpose: "Networking lab practice" },
  {
    who: "keo.sophal", item: "Dell Latitude 5440 Laptop", from: -4, to: 1, status: "cancelled", by: "pich.sopheap", purpose: "Exam invigilation",
    reason: "The exam moved online, so the laptop is not needed.",
  },
  { who: "sok.dara", item: "Sony ZV-E10 Camera", from: -14, to: -10, returned: -10, status: "returned", by: "chan.sokha", purpose: "Short film for media class" },
  { who: "heng.bopha", item: "HDMI Cable 3 m", from: -8, to: -6, returned: -7, status: "returned", by: "pich.sopheap", purpose: "Seminar in the main hall" },
  { who: "chea.vanna", item: "Epson EB-X49 Projector", from: -20, to: -15, returned: -15, status: "returned", by: "chan.sokha", purpose: "Thesis defence rehearsal" },
];

const emailOf = (who) => DEMO_ACCOUNTS.find((a) => a.email.startsWith(`${who}@`)).email;
// 02:00 UTC is 09:00 in Phnom Penh, a plausible office hour for every stored time.
const at = (day, hourUTC = 2) => `${day}T${String(hourUTC).padStart(2, "0")}:00:00.000Z`;
const sqlTime = (day) => `${day} 02:00:00`;
const MESSAGES = {
  approved: (item) => `Your request for ${item} was approved.`,
  rejected: (item) => `Your request for ${item} was rejected.`,
  returned: (item) => `Your loan of ${item} was marked returned.`,
  cancelled: (item, byAdmin, reason) =>
    byAdmin ? `Your request for ${item} was cancelled by an administrator.${reason ? ` Reason: ${reason}` : ""}` : `Your request for ${item} was cancelled.`,
};

// Refuses a missing or weak password, and the public seed:test password.
export function demoPasswordError(password) {
  if (!password) return "Set DEMO_PASSWORD in .env first. Every demo account uses it, so keep it out of the repo.";
  if (password === TEST_PASSWORD) return "DEMO_PASSWORD must not be the public test password.";
  const weak = passwordError(password);
  return weak ? `DEMO_PASSWORD: ${weak}` : null;
}

// Empties every table and loads the demo data in one transaction. Returns how many rows of each kind it wrote.
export async function seedDemo(db, password, today = todayISO()) {
  const problem = demoPasswordError(password);
  if (problem) throw new Error(problem);
  const hash = await hashPassword(password);
  const known = [...DEMO_ACCOUNTS, ...TEST_ACCOUNTS].map((a) => a.email);
  return withTransaction(db, async (tx) => {
    const others = (await tx.prepare("SELECT COUNT(*)::int AS n FROM users WHERE NOT (email = ANY(?))").get(known)).n;
    if (others > 0) {
      throw new Error(`Refusing to load demo data: ${others} account(s) here are not demo or test accounts, and loading would delete them. Nothing was changed.`);
    }
    await tx.exec("TRUNCATE notifications, borrow_requests, sessions, equipment, users RESTART IDENTITY CASCADE");

    const joined = addDaysISO(today, -30);
    const userIds = {};
    for (const { email, role } of DEMO_ACCOUNTS) {
      const row = await tx
        .prepare("INSERT INTO users (email, full_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
        .run(email, displayName(email), role, hash, sqlTime(joined));
      userIds[email.split("@")[0]] = row.lastInsertRowid;
    }
    const itemIds = {};
    for (const { name, category, quantity } of DEMO_EQUIPMENT) {
      const row = await tx
        .prepare("INSERT INTO equipment (name, category, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
        .run(name, category, quantity, sqlTime(joined), sqlTime(joined));
      itemIds[name] = row.lastInsertRowid;
    }

    for (const r of DEMO_REQUESTS) {
      const from = addDaysISO(today, r.from);
      const created = at(addDaysISO(today, r.from - 2), 1); // asked two days before the start
      const decided = r.by ? at(addDaysISO(today, r.from - 1)) : null;
      const returnedAt = r.returned === undefined ? null : at(addDaysISO(today, r.returned), 9);
      const { lastInsertRowid: id } = await tx
        .prepare(
          `INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, purpose, status, returned_at, created_at, decided_by, decided_at, decision_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .run(itemIds[r.item], userIds[r.who], from, addDaysISO(today, r.to), r.purpose, r.status, returnedAt, created,
          r.by ? userIds[r.by] : null, decided, r.reason ?? null);

      const name = displayName(emailOf(r.who));
      await notifyAdmins(tx, { type: "request_submitted", message: `New borrow request from ${name} for ${r.item}.`, requestId: id, createdAt: created });
      const userId = userIds[r.who];
      if (r.status === "approved" || r.status === "returned") {
        await notify(tx, { userId, type: "request_approved", message: MESSAGES.approved(r.item), requestId: id, createdAt: decided });
      }
      if (r.status === "rejected") {
        await notify(tx, { userId, type: "request_rejected", message: MESSAGES.rejected(r.item), reason: r.reason, requestId: id, createdAt: decided });
      }
      if (r.status === "returned") {
        await notify(tx, { userId, type: "request_returned", message: MESSAGES.returned(r.item), requestId: id, createdAt: returnedAt });
      }
      if (r.status === "cancelled") {
        await notify(tx, { userId, type: "request_cancelled", message: MESSAGES.cancelled(r.item, Boolean(r.by), r.reason), requestId: id, createdAt: decided ?? at(addDaysISO(today, r.from - 1)) });
      }
    }

    // Stock follows the loans: what is out on an approved loan is not on the shelf.
    await tx.exec(`UPDATE equipment e SET available = e.quantity - (
      SELECT COUNT(*) FROM borrow_requests r WHERE r.equipment_id = e.id AND r.status = 'approved')`);
    // Notices older than two days count as read, so each bell shows a few new ones and some history.
    await tx.prepare("UPDATE notifications SET read_at = created_at WHERE created_at < ?").run(at(addDaysISO(today, -2)));

    const count = async (table) => (await tx.prepare(`SELECT COUNT(*)::int AS n FROM ${table}`).get()).n;
    return { users: await count("users"), equipment: await count("equipment"), requests: await count("borrow_requests"), notifications: await count("notifications") };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const path = args.find((arg) => !arg.startsWith("--"));
  const stop = (message) => {
    console.error(message);
    process.exit(1);
  };
  if (process.env.NODE_ENV === "production") stop("Refusing to load demo data with NODE_ENV=production.");
  const problem = demoPasswordError(process.env.DEMO_PASSWORD);
  if (problem) stop(problem);
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (databaseUrl && !isPostgresUrl(databaseUrl)) {
    stop("DATABASE_URL is not a postgres:// or postgresql:// URL, so nothing was done. Fix it or unset it for the local copy.");
  }
  // Loading empties the database first, so the live one is only reached on purpose.
  if (databaseUrl && !args.includes("--remote")) {
    stop("Refusing to load demo data: DATABASE_URL is set, so this would empty that database first. Pass --remote to do it anyway, or unset DATABASE_URL for the local copy.");
  }
  const where = databaseUrl ? "DATABASE_URL" : path || process.env.PGDATA_DIR || "data/pgdata"; // the URL holds a password
  let db;
  try {
    db = await openDb(databaseUrl || where);
    const counts = await seedDemo(db, process.env.DEMO_PASSWORD);
    console.log(`Demo data in ${where}: ${counts.users} accounts, ${counts.equipment} items, ${counts.requests} requests, ${counts.notifications} notices.`);
    console.log("Every account below uses DEMO_PASSWORD from .env:");
    for (const { email, role } of DEMO_ACCOUNTS) console.log(`  ${role.padEnd(8)} ${email}`);
  } catch (err) {
    console.error(err.message || err.code || err);
    process.exitCode = 1;
  } finally {
    await db?.close();
  }
}
