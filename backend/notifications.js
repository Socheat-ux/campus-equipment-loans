import { Router } from "express";
import { requireAuth } from "./auth.js";
import { isId, withTransaction } from "./db.js";
import { addDaysISO, REJECTION_REASON_MAX, todayISO } from "../shared/rules.js";

// Add new kinds here, for example "due_soon" and "overdue" for the reminder stories.
export const NOTIFICATION_TYPES = ["request_submitted", "request_approved", "request_rejected", "due_soon", "request_returned", "request_cancelled"];
export const MESSAGE_MAX = 300;
export const REASON_MAX = REJECTION_REASON_MAX;
export const LIST_LIMIT = 50;
const PG_INT_MAX = 2147483647;
const TITLES = {
  request_submitted: "Request submitted",
  request_approved: "Request approved",
  request_rejected: "Request rejected",
  due_soon: "Return due tomorrow",
  request_returned: "Equipment returned",
  request_cancelled: "Request cancelled",
};

// Server code calls this, inside withTransaction(db, ...) together with the change it reports.
// Only server code calls it, so bad input is a bug and throws instead of answering 400.
export async function notify(db, { userId, type, message, reason, requestId, createdAt } = {}) {
  // isTransaction is undefined on drivers without it; then there is nothing to check.
  if (db.isTransaction === false) throw new TypeError("notify: call it inside withTransaction(db, ...) with the change it reports.");
  if (!Number.isInteger(userId) || userId < 1) throw new TypeError("notify: userId must be a positive integer.");
  if (!NOTIFICATION_TYPES.includes(type)) throw new TypeError(`notify: unknown type "${type}".`);
  const text = typeof message === "string" ? message.trim() : "";
  if (!text || text.length > MESSAGE_MAX) throw new TypeError(`notify: message must be 1 to ${MESSAGE_MAX} characters.`);
  if (requestId !== undefined && (!Number.isInteger(requestId) || requestId < 1)) {
    throw new TypeError("notify: requestId must be a positive integer.");
  }
  if (createdAt !== undefined && (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt)))) {
    throw new TypeError("notify: createdAt must be an ISO date.");
  }

  let why = null;
  if (type === "request_rejected") {
    why = typeof reason === "string" ? reason.trim() : "";
    if (!why || why.length > REASON_MAX) throw new TypeError(`notify: a rejection needs a reason of 1 to ${REASON_MAX} characters.`);
  }

  // Returns the new id, or undefined when the unique index says this notice already exists.
  const info = await db
    .prepare(
      `INSERT INTO notifications (user_id, type, title, message, reason, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
       ON CONFLICT DO NOTHING RETURNING id`,
    )
    .run(userId, type, TITLES[type], text, why, requestId ?? null, createdAt ?? null);
  return info.lastInsertRowid;
}

export async function notifyAdmins(db, { type, message, reason, requestId, createdAt } = {}) {
  const admins = await db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id").all();
  for (const admin of admins) await notify(db, { userId: admin.id, type, message, reason, requestId, createdAt });
  return admins.length;
}

// Called while loading the user's bell. The unique index on (user, request, type) makes polling safe to repeat.
export async function processDueReminders(db, today = todayISO()) {
  const dueDate = addDaysISO(today, 1);
  if (!dueDate) return 0;
  // Most polls find nothing, so a read decides whether to write at all.
  const anyDue = await db.prepare(`
    SELECT r.id
    FROM borrow_requests r
    WHERE r.status = 'approved' AND r.return_date = ?
      AND NOT EXISTS (
        SELECT 1 FROM notifications n WHERE n.user_id = r.user_id AND n.request_id = r.id AND n.type = 'due_soon'
      )
    LIMIT 1
  `).get(dueDate);
  if (!anyDue) return 0;
  // One statement that re-checks status = 'approved' as it inserts (and locks those rows against a concurrent return),
  // so a loan returned since the read above gets no reminder. The text and title match what notify() writes.
  const { changes } = await db.prepare(`
    INSERT INTO notifications (user_id, type, title, message, request_id)
    SELECT r.user_id, 'due_soon', ?::text, 'Return ' || e.name || ' by ' || r.return_date || '.', r.id
    FROM borrow_requests r JOIN equipment e ON e.id = r.equipment_id
    WHERE r.status = 'approved' AND r.return_date = ?
      AND NOT EXISTS (
        SELECT 1 FROM notifications n WHERE n.user_id = r.user_id AND n.request_id = r.id AND n.type = 'due_soon'
      )
    ORDER BY r.id
    FOR SHARE OF r
    ON CONFLICT DO NOTHING
  `).run(TITLES.due_soon, dueDate);
  return changes;
}

// Requests submitted before an admin existed (or before admin notices were added) still need to show in the bell.
export async function backfillAdminRequestNotifications(db, adminId) {
  if (!Number.isInteger(adminId) || adminId < 1) throw new TypeError("backfill: adminId must be a positive integer.");
  // Read first: almost every bell load has nothing to add, and then no transaction is opened.
  const legacyMessages = new Set(
    (
      await db
        .prepare("SELECT message FROM notifications WHERE user_id = ? AND type = 'request_submitted' AND request_id IS NULL")
        .all(adminId)
    ).map((row) => row.message),
  );
  const rows = await db
    .prepare(
      `SELECT r.id, r.created_at, e.name AS equipment_name, u.full_name, u.email
       FROM borrow_requests r
       JOIN equipment e ON e.id = r.equipment_id
       JOIN users u ON u.id = r.user_id
       WHERE NOT EXISTS (
         SELECT 1 FROM notifications n WHERE n.user_id = ? AND n.request_id = r.id
       )
       ORDER BY r.created_at, r.id`,
    )
    .all(adminId);
  const todo = rows
    .map((row) => ({ row, message: `New borrow request from ${row.full_name || row.email} for ${row.equipment_name}.`.slice(0, MESSAGE_MAX) }))
    .filter(({ message }) => !legacyMessages.has(message));
  if (!todo.length) return 0;
  return withTransaction(db, async (tx) => {
    let added = 0;
    for (const { row, message } of todo) {
      const id = await notify(tx, {
        userId: adminId,
        type: "request_submitted",
        message,
        requestId: row.id,
        createdAt: row.created_at,
      });
      if (id !== undefined) added++;
    }
    return added;
  });
}

const asNotification = (row) => ({
  id: row.id,
  type: row.type,
  message: row.message,
  reason: row.reason,
  read: row.read_at !== null,
  createdAt: row.created_at,
});

export function notificationsRouter(db) {
  const router = Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // Every route below is about the signed-in user's own notifications.
  router.use(requireAuth(db));

  const unreadCount = async (userId) =>
    (await db.prepare("SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(userId)).n;

  router.get("/", async (req, res) => {
    await processDueReminders(db);
    if (req.user.role === "admin") await backfillAdminRequestNotifications(db, req.user.id);
    const rows = await db
      .prepare(
        `SELECT id, type, message, reason, read_at, created_at FROM notifications
         WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(req.user.id, LIST_LIMIT);
    res.json({ notifications: rows.map(asNotification), unread: await unreadCount(req.user.id) });
  });

  // Body { "all": true } marks all of the caller's notifications read, { "all": true, "upTo": id } only those with
  // id <= upTo, and { "ids": [...] } only the listed ones. Anything else is a 400, so a typo can never mean "mark everything".
  router.post("/read", async (req, res) => {
    // Without a JSON body there is nothing to check, and an empty body would mean "mark all".
    if (!req.is("application/json")) return res.status(415).json({ error: "JSON only." });
    if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Send an object." });
    }
    const keys = Object.keys(req.body).sort().join();
    const { ids, all, upTo } = req.body;
    if (keys !== "ids" && keys !== "all" && keys !== "all,upTo") {
      return res.status(400).json({ error: 'Send exactly { "ids": [1, 2] }, { "all": true } or { "all": true, "upTo": 5 }.' });
    }
    if (keys !== "ids" && all !== true) return res.status(400).json({ error: "all must be true." });
    if (keys === "all,upTo" && !(Number.isInteger(upTo) && upTo > 0)) {
      return res.status(400).json({ error: "upTo must be a positive integer." });
    }
    if (
      keys === "ids" &&
      (!Array.isArray(ids) || ids.length === 0 || ids.length > LIST_LIMIT || !ids.every((id) => Number.isInteger(id) && id > 0))
    ) {
      return res.status(400).json({ error: `ids must be a list of 1 to ${LIST_LIMIT} notification ids.` });
    }

    const now = new Date().toISOString();
    // Ids are integers in Postgres: anything above its range cannot exist, so it is left out instead of failing the query.
    const known = ids?.filter((id) => id <= PG_INT_MAX);
    if (ids) {
      if (known.length) {
        await db.prepare(
          `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${known.map(() => "?").join(", ")})`,
        ).run(now, req.user.id, ...known);
      }
    } else if (upTo === undefined) {
      await db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(now, req.user.id);
    } else {
      await db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id <= ?").run(
        now,
        req.user.id,
        Math.min(upTo, PG_INT_MAX),
      );
    }
    res.json({ unread: await unreadCount(req.user.id) });
  });

  router.post("/read-all", async (req, res) => {
    await db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(
      new Date().toISOString(),
      req.user.id,
    );
    res.json({ unread: await unreadCount(req.user.id) });
  });

  router.post("/:id/read", async (req, res) => {
    const id = Number(req.params.id);
    if (!isId(id)) return res.status(404).json({ error: "Notification not found." });
    const result = await db
      .prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL")
      .run(new Date().toISOString(), id, req.user.id);
    if (!result.changes) {
      const own = await db.prepare("SELECT 1 FROM notifications WHERE id = ? AND user_id = ?").get(id, req.user.id);
      if (!own) return res.status(404).json({ error: "Notification not found." });
    }
    res.json({ unread: await unreadCount(req.user.id) });
  });

  return router;
}
