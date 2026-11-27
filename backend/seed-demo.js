// Loads the demo data for screenshots, the run guide and the presentation: npm run seed:demo [database path] [--remote]
// DATABASE_URL wins, then the path (a PGlite folder), then PGDATA_DIR or data/pgdata, like the server.
// Every demo account uses DEMO_PASSWORD from .env, so no password is written in the repo.
// It empties the database and loads the same data again, so it only runs when every account is a demo account with DEMO_PASSWORD or a test account.
import { pathToFileURL } from "node:url";
import { isPostgresUrl, openDb, withTransaction } from "./db.js";
import { checkPassword, hashPassword } from "./auth.js";
import { notify, notifyAdmins } from "./notifications.js";
import { TEST_ACCOUNTS, TEST_PASSWORD } from "./seed-dev.js";
import { addDaysISO, BORROW_MAX_DAYS, displayName, passwordError, todayISO } from "../shared/rules.js";

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
// from is the borrow day; the return date is always from + BORROW_MAX_DAYS, as the app stores it. by is the deciding admin.
// returned is the day it came back. A cancelled request with by was an approved loan that an administrator cancelled.
export const DEMO_REQUESTS = [
  { who: "sok.dara", item: "Epson EB-X49 Projector", from: 1, status: "pending", purpose: "Group presentation for the database course" },
  { who: "chea.vanna", item: "MacBook Air M2", from: 0, status: "pending", purpose: "Editing the club video, starting today" },
  { who: "keo.sophal", item: "Sony ZV-E10 Camera", from: 3, status: "pending", purpose: "Recording guest lectures" },
  { who: "ly.sreymom", item: "Dell Latitude 5440 Laptop", from: -2, status: "approved", by: "chan.sokha", purpose: "Programming assignment" },
  { who: "phan.rithy", item: "Canon EOS 250D Camera", from: -1, status: "approved", by: "pich.sopheap", purpose: "Photos for the campus open day" },
  { who: "noun.sovann", item: "Arduino Uno Starter Kit", from: -6, status: "approved", by: "chan.sokha", purpose: "IoT lab project, due back tomorrow" },
  { who: "chea.vanna", item: "JBL Charge 5 Speaker", from: -7, status: "approved", by: "chan.sokha", purpose: "Student council event, due back today" },
  { who: "sok.dara", item: "Dell Latitude 5440 Laptop", from: -10, status: "approved", by: "pich.sopheap", purpose: "Capstone prototype" },
  { who: "heng.bopha", item: "Epson EB-X49 Projector", from: -9, status: "approved", by: "chan.sokha", purpose: "Workshop in room B204" },
  {
    who: "phan.rithy", item: "MacBook Air M2", from: 2, status: "rejected", by: "chan.sokha", purpose: "Design homework",
    reason: "Both MacBooks are booked for the design workshop that week. Please choose a Dell laptop instead.",
  },
  {
    who: "noun.sovann", item: "Sony ZV-E10 Camera", from: 1, status: "rejected", by: "pich.sopheap", purpose: "Podcast video recording",
    reason: "Both cameras are reserved for the film festival that week. Please choose another date.",
  },
  { who: "ly.sreymom", item: "TP-Link Archer AX55 Router", from: 2, status: "cancelled", purpose: "Networking lab practice" },
  {
    who: "keo.sophal", item: "Dell Latitude 5440 Laptop", from: -4, status: "cancelled", by: "pich.sopheap", purpose: "Exam invigilation",
    reason: "The exam moved online, so the laptop is not needed.",
  },
  { who: "sok.dara", item: "Sony ZV-E10 Camera", from: -14, returned: -10, status: "returned", by: "chan.sokha", purpose: "Short film for media class" },
  { who: "heng.bopha", item: "HDMI Cable 3 m", from: -8, returned: -1, status: "returned", by: "pich.sopheap", purpose: "Seminar in the main hall" },
  { who: "chea.vanna", item: "Epson EB-X49 Projector", from: -20, returned: -15, status: "returned", by: "chan.sokha", purpose: "Thesis defence rehearsal" },
];

const emailOf = (who) => DEMO_ACCOUNTS.find((a) => a.email.startsWith(`${who}@`)).email;
// 02:00 UTC is 09:00 in Phnom Penh, a plausible office hour for every stored time.
const at = (day, hourUTC = 2) => `${day}T${String(hourUTC).padStart(2, "0")}:00:00.000Z`;
const sqlTime = (day) => `${day} 02:00:00`;
const LOCATION = "Main store"; // the equipment column default, which the approval notice names
// The app's own notice texts (borrowRequests.js and adminBorrowRequests.js).
const MESSAGES = {
  submitted: (item) => `Your request for ${item} was submitted and is awaiting approval.`,
  approved: (item, from, to) => `Request approved. ${item} is ready for pickup at ${LOCATION} on ${from}; return by ${to}.`,
  rejected: (item) => `Request rejected. ${item}. See the reason in My requests.`,
  returned: (item) => `Equipment returned: ${item}.`,
  cancelled: (item, byAdmin, reason) =>
    byAdmin ? `Your request for ${item} was cancelled by an administrator.${reason ? ` Reason: ${reason}` : ""}`.slice(0, 300) : `Your request for ${item} was cancelled.`,
};

// Refuses a missing or weak password, and the public seed:test password.
export function demoPasswordError(password) {
  if (!password) return "Set DEMO_PASSWORD in .env first. Every demo account uses it, so keep it out of the repo.";
  if (password === TEST_PASSWORD) return "DEMO_PASSWORD must not be the public test password.";
  const weak = passwordError(password);
  return weak ? `DEMO_PASSWORD: ${weak}` : null;
}

// Empties every table and loads the demo data in one transaction. Returns how many rows of each kind it wrote.
// Every stored time is on an earlier day than today, so none is in the future whatever the hour.
export async function seedDemo(db, password, today = todayISO()) {
  const problem = demoPasswordError(password);
  if (problem) throw new Error(problem);
  const hash = await hashPassword(password);
  const demoEmails = DEMO_ACCOUNTS.map((a) => a.email);
  const known = [...demoEmails, ...TEST_ACCOUNTS.map((a) => a.email)];
  return withTransaction(db, async (tx) => {
    // A signup that commits between the check below and the TRUNCATE would be deleted unseen, so inserts into users wait here.
    await tx.exec("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
    const blocking = (await tx.prepare("SELECT email FROM users WHERE NOT (email = ANY(?)) ORDER BY id").all(known)).map((u) => u.email);
    // A real person may have signed up with a demo name, so a demo email only counts as ours when DEMO_PASSWORD opens it.
    const demoRows = await tx.prepare("SELECT email, password_hash FROM users WHERE email = ANY(?) ORDER BY id").all(demoEmails);
    const ours = await Promise.all(demoRows.map((u) => checkPassword(password, u.password_hash).catch(() => false)));
    demoRows.forEach((u, i) => ours[i] || blocking.push(u.email));
    if (blocking.length > 0) {
      throw new Error(
        `Refusing to load demo data: ${blocking.length} account(s) here are not demo or test accounts, or are demo accounts with another password, and loading would delete them (${blocking.join(", ")}). Nothing was changed.`,
      );
    }
    // Every table that references users or equipment is listed, so CASCADE is not needed.
    await tx.exec("TRUNCATE notifications, borrow_requests, sessions, equipment, users RESTART IDENTITY");

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

    // Asked at least two days back and decided the day after, so every time is in the past. Rows and notices go in
    // oldest first, because the app lists by id, newest first.
    const day = (n, hourUTC) => at(addDaysISO(today, n), hourUTC);
    const byTime = (x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0);
    const timed = DEMO_REQUESTS.map((r) => {
      const adminCancel = r.status === "cancelled" && r.by;
      // Cancelling a loan overwrites decided_at with the cancel time, so the approval time only lives in its notice.
      const cancelDay = adminCancel ? Math.min(r.from + 1, -1) : Math.min(r.from - 1, -1);
      return {
        ...r,
        at: day(Math.min(r.from - 2, -2), 1),
        approvedAt: r.by ? day(Math.min(r.from - 1, -1)) : null,
        decidedAt: adminCancel ? day(cancelDay) : r.by ? day(Math.min(r.from - 1, -1)) : null,
        cancelledAt: r.status === "cancelled" ? day(cancelDay) : null,
        returnedAt: r.returned === undefined ? null : day(r.returned, 9),
      };
    }).sort(byTime);

    const notices = [];
    for (const r of timed) {
      const from = addDaysISO(today, r.from);
      const to = addDaysISO(from, BORROW_MAX_DAYS);
      const { lastInsertRowid: id } = await tx
        .prepare(
          `INSERT INTO borrow_requests (equipment_id, user_id, borrow_date, return_date, purpose, status, returned_at, created_at, decided_by, decided_at, decision_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .run(itemIds[r.item], userIds[r.who], from, to, r.purpose, r.status, r.returnedAt, r.at,
          r.by ? userIds[r.by] : null, r.decidedAt, r.reason ?? null);

      const note = (when, type, message, extra) => notices.push({ at: when, userId: userIds[r.who], type, message, requestId: id, ...extra });
      note(r.at, "request_submitted", MESSAGES.submitted(r.item));
      notices.push({ at: r.at, toAdmins: true, type: "request_submitted", message: `New borrow request from ${displayName(emailOf(r.who))} for ${r.item}.`, requestId: id });
      if (r.approvedAt && r.status !== "rejected") note(r.approvedAt, "request_approved", MESSAGES.approved(r.item, from, to));
      if (r.status === "rejected") note(r.decidedAt, "request_rejected", MESSAGES.rejected(r.item), { reason: r.reason });
      if (r.status === "returned") note(r.returnedAt, "request_returned", MESSAGES.returned(r.item));
      if (r.status === "cancelled") note(r.cancelledAt, "request_cancelled", MESSAGES.cancelled(r.item, Boolean(r.by), r.reason));
    }
    notices.sort(byTime); // stable, so ties keep request order
    for (const { at: createdAt, toAdmins, ...n } of notices) {
      if (toAdmins) await notifyAdmins(tx, { ...n, createdAt });
      else await notify(tx, { ...n, createdAt });
    }

    // Stock follows the loans: what is out on an approved loan is not on the shelf.
    await tx.exec(`UPDATE equipment e SET available = e.quantity - (
      SELECT COUNT(*) FROM borrow_requests r WHERE r.equipment_id = e.id AND r.status = 'approved')`);
    // Notices from before the last two days count as read, so each bell shows a few new ones and some history.
    await tx.prepare("UPDATE notifications SET read_at = created_at WHERE created_at < ?").run(day(-2, 0));

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
