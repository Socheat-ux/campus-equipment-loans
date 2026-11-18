import { Router } from "express";
import { requireRole } from "./auth.js";
import { withTransaction } from "./db.js";
import { MESSAGE_MAX, notify, notifyAdmins } from "./notifications.js";
import { borrowRequestInput } from "./rules.js";

const selectColumns = `
  SELECT r.id, r.equipment_id, e.name AS equipment_name, e.category AS equipment_category,
         e.location AS equipment_location,
         r.user_id, r.borrow_date, r.return_date, r.purpose, r.status, r.created_at, r.decision_reason
  FROM borrow_requests r JOIN equipment e ON e.id = r.equipment_id`;

const asRequest = (row) => ({
  id: row.id,
  equipmentId: row.equipment_id,
  equipmentName: row.equipment_name,
  equipmentCategory: row.equipment_category,
  equipmentLocation: row.equipment_location,
  userId: row.user_id,
  borrowDate: row.borrow_date,
  returnDate: row.return_date,
  purpose: row.purpose,
  status: row.status,
  createdAt: row.created_at,
  decisionReason: row.decision_reason,
});

export function borrowRequestsRouter(db) {
  const router = Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // Students and faculty borrow equipment; administrators approve requests elsewhere.
  router.use(requireRole(db, "student", "faculty"));
  router.use((req, res, next) =>
    req.method === "POST" && !req.is("application/json")
      ? res.status(415).json({ error: "JSON only." })
      : next(),
  );

  router.get("/", (req, res) => {
    const rows = db
      .prepare(`${selectColumns} WHERE r.user_id = ? ORDER BY r.id DESC`)
      .all(req.user.id);
    res.json({ requests: rows.map(asRequest) });
  });

  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: "Request not found." });
    const row = db.prepare(`${selectColumns} WHERE r.id = ? AND r.user_id = ?`).get(id, req.user.id);
    return row ? res.json({ request: asRequest(row) }) : res.status(404).json({ error: "Request not found." });
  });

  router.post("/", (req, res) => {
    const { fields, value } = borrowRequestInput(req.body);
    if (Object.keys(fields).length) return res.status(400).json({ error: "Please fix the fields below.", fields });

    const equipment = db
      .prepare("SELECT id, name, quantity FROM equipment WHERE id = ?")
      .get(value.equipmentId);
    if (!equipment) return res.status(404).json({ error: "Equipment not found." });
    if (equipment.quantity < 1) {
      return res.status(400).json({
        error: "This item is no longer available.",
        fields: { equipmentId: "This item is no longer available." },
      });
    }

    const id = withTransaction(db, () => {
      const info = db
        .prepare(
          `INSERT INTO borrow_requests
             (equipment_id, user_id, borrow_date, return_date, purpose, status)
           VALUES (?, ?, ?, ?, ?, 'pending')`,
        )
        .run(equipment.id, req.user.id, value.borrowDate, value.returnDate, value.purpose);
      const requestId = Number(info.lastInsertRowid);
      const createdAt = db.prepare("SELECT created_at FROM borrow_requests WHERE id = ?").get(requestId).created_at;
      notify(db, {
        userId: req.user.id,
        type: "request_submitted",
        message: `Your request for ${equipment.name} was submitted and is awaiting approval.`,
        requestId,
        createdAt,
      });
      notifyAdmins(db, {
        type: "request_submitted",
        message: `New borrow request from ${req.user.fullName || req.user.email} for ${equipment.name}.`.slice(
          0,
          MESSAGE_MAX,
        ),
        requestId,
        createdAt,
      });
      return requestId;
    });

    const row = db.prepare(`${selectColumns} WHERE r.id = ?`).get(id);
    res.status(201).json({ request: asRequest(row) });
  });

  router.post("/:id/cancel", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: "Request not found." });

    const row = db.prepare(`${selectColumns} WHERE r.id = ? AND r.user_id = ?`).get(id, req.user.id);
    if (!row) return res.status(404).json({ error: "Request not found." });
    if (row.status !== "pending") return res.status(409).json({ error: "Only pending requests can be cancelled." });

    try {
      withTransaction(db, () => {
        const current = db
          .prepare("SELECT status FROM borrow_requests WHERE id = ? AND user_id = ?")
          .get(id, req.user.id);
        if (!current || current.status !== "pending") {
          throw Object.assign(new Error("Only pending requests can be cancelled."), { status: 409 });
        }

        // Pending requests do not reserve stock, so cancelling them does not change equipment availability.
        const updated = db
          .prepare("UPDATE borrow_requests SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'")
          .run(id, req.user.id);
        if (!updated.changes) {
          throw Object.assign(new Error("Only pending requests can be cancelled."), { status: 409 });
        }

        notify(db, {
          userId: req.user.id,
          type: "request_cancelled",
          message: `Your request for ${row.equipment_name} was cancelled.`.slice(0, MESSAGE_MAX),
          requestId: id,
        });
      });
    } catch (err) {
      if (err?.status === 409) return res.status(409).json({ error: "Only pending requests can be cancelled." });
      throw err;
    }

    const updatedRow = db.prepare(`${selectColumns} WHERE r.id = ? AND r.user_id = ?`).get(id, req.user.id);
    return res.json({ request: asRequest(updatedRow) });
  });

  return router;
}
