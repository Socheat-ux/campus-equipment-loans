import { Router } from "express";
import { requireAuth } from "./auth.js";

// Add new kinds here, for example "due_soon" and "overdue" for the reminder stories.
export const NOTIFICATION_TYPES = ["request_approved", "request_rejected"];
export const MESSAGE_MAX = 300;
export const REASON_MAX = 500;
export const LIST_LIMIT = 50;

// Server code calls this, inside withTransaction(db, ...) together with the change it reports.
// Only server code calls it, so bad input is a bug and throws instead of answering 400.
export function notify(db, { userId, type, message, reason } = {}) {
  // isTransaction is undefined on drivers without it; then there is nothing to check.
  if (db.isTransaction === false) throw new TypeError("notify: call it inside withTransaction(db, ...) with the change it reports.");
  if (!Number.isInteger(userId) || userId < 1) throw new TypeError("notify: userId must be a positive integer.");
  if (!NOTIFICATION_TYPES.includes(type)) throw new TypeError(`notify: unknown type "${type}".`);
  const text = typeof message === "string" ? message.trim() : "";
  if (!text || text.length > MESSAGE_MAX) throw new TypeError(`notify: message must be 1 to ${MESSAGE_MAX} characters.`);

  let why = null;
  if (type === "request_rejected") {
    why = typeof reason === "string" ? reason.trim() : "";
    if (!why || why.length > REASON_MAX) throw new TypeError(`notify: a rejection needs a reason of 1 to ${REASON_MAX} characters.`);
  }

  const info = db
    .prepare("INSERT INTO notifications (user_id, type, message, reason) VALUES (?, ?, ?, ?)")
    .run(userId, type, text, why);
  return Number(info.lastInsertRowid);
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

  return router;
}
