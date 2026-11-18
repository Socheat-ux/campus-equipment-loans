import { Router } from "express";
import { requireAuth } from "./auth.js";
import { withTransaction } from "./db.js";
import { REJECTION_REASON_MAX } from "./rules.js";

// Add new kinds here, for example "due_soon" and "overdue" for the reminder stories.
export const NOTIFICATION_TYPES = ["request_submitted", "request_approved", "request_rejected"];
export const MESSAGE_MAX = 300;
export const REASON_MAX = REJECTION_REASON_MAX;
export const LIST_LIMIT = 50;

// Server code calls this, inside withTransaction(db, ...) together with the change it reports.
// Only server code calls it, so bad input is a bug and throws instead of answering 400.
export function notify(db, { userId, type, message, reason, requestId, createdAt } = {}) {
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

  const info = db
    .prepare(
      `INSERT INTO notifications (user_id, type, message, reason, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`,
    )
    .run(userId, type, text, why, requestId ?? null, createdAt ?? null);
  return Number(info.lastInsertRowid);
}

export function notifyAdmins(db, { type, message, reason, requestId, createdAt } = {}) {
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id").all();
  for (const admin of admins) notify(db, { userId: admin.id, type, message, reason, requestId, createdAt });
  return admins.length;
}

// Requests submitted before an admin existed (or before admin notices were added) still need to show in the bell.
export function backfillAdminRequestNotifications(db, adminId) {
  if (!Number.isInteger(adminId) || adminId < 1) throw new TypeError("backfill: adminId must be a positive integer.");
  return withTransaction(db, () => {
    const legacyMessages = new Set(
      db
        .prepare("SELECT message FROM notifications WHERE user_id = ? AND type = 'request_submitted' AND request_id IS NULL")
        .all(adminId)
        .map((row) => row.message),
    );
    const rows = db
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
    let added = 0;
    for (const row of rows) {
      const message = `New borrow request from ${row.full_name || row.email} for ${row.equipment_name}.`.slice(0, MESSAGE_MAX);
      if (legacyMessages.has(message)) continue;
      notify(db, {
        userId: adminId,
        type: "request_submitted",
        message,
        requestId: row.id,
        createdAt: row.created_at,
      });
      added++;
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

  const unreadCount = (userId) =>
    db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(userId).n;

  router.get("/", (req, res) => {
    if (req.user.role === "admin") backfillAdminRequestNotifications(db, req.user.id);
    const rows = db
      .prepare(
        `SELECT id, type, message, reason, read_at, created_at FROM notifications
         WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(req.user.id, LIST_LIMIT);
    res.json({ notifications: rows.map(asNotification), unread: unreadCount(req.user.id) });
  });

  // Body { "all": true } marks all of the caller's notifications read, { "all": true, "upTo": id } only those with
  // id <= upTo, and { "ids": [...] } only the listed ones. Anything else is a 400, so a typo can never mean "mark everything".
  router.post("/read", (req, res) => {
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
    if (ids) {
      db.prepare(
        `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => "?").join(", ")})`,
      ).run(now, req.user.id, ...ids);
    } else {
      db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id <= ?").run(
        now,
        req.user.id,
        upTo ?? Number.MAX_SAFE_INTEGER,
      );
    }
    res.json({ unread: unreadCount(req.user.id) });
  });

  router.post("/read-all", (req, res) => {
    db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(
      new Date().toISOString(),
      req.user.id,
    );
    res.json({ unread: unreadCount(req.user.id) });
  });

  router.post("/:id/read", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: "Notification not found." });
    const result = db
      .prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL")
      .run(new Date().toISOString(), id, req.user.id);
    if (!result.changes) {
      const own = db.prepare("SELECT 1 FROM notifications WHERE id = ? AND user_id = ?").get(id, req.user.id);
      if (!own) return res.status(404).json({ error: "Notification not found." });
    }
    res.json({ unread: unreadCount(req.user.id) });
  });

  return router;
}
