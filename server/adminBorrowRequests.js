import { Router } from "express";
import { requireAdmin } from "./auth.js";
import { withTransaction } from "./db.js";
import { notify } from "./notifications.js";
import { addDaysISO, BORROW_MAX_DAYS, rejectionReasonError } from "./rules.js";

const STATUSES = ["pending", "approved", "rejected"];

const selectColumns = `
  SELECT r.id, r.equipment_id, e.name AS equipment_name, e.asset_id AS equipment_asset_id,
         e.location AS equipment_location, e.quantity AS stock,
         r.user_id, u.full_name AS requester_name, u.role AS requester_role,
         r.borrow_date, r.return_date, r.purpose, r.status, r.created_at,
         r.decided_by, r.decided_at, r.decision_reason, r.returned_at
  FROM borrow_requests r
  JOIN equipment e ON e.id = r.equipment_id
  JOIN users u ON u.id = r.user_id`;

const asAdminRequest = (row) => ({
  id: row.id,
  equipmentId: row.equipment_id,
  equipmentName: row.equipment_name,
  equipmentAssetId: row.equipment_asset_id,
  equipmentLocation: row.equipment_location,
  stock: row.stock,
  userId: row.user_id,
  requesterName: row.requester_name,
  requesterRole: row.requester_role,
  borrowDate: row.borrow_date,
  returnDate: row.return_date,
  purpose: row.purpose,
  status: row.status,
  createdAt: row.created_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  returnedAt: row.returned_at,
});

class ConflictError extends Error {}
const conflict = (message) => Object.assign(new ConflictError(message), { status: 409 });

export function adminBorrowRequestsRouter(db) {
  const router = Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(requireAdmin(db));

  const findRequest = (id) => db.prepare(`${selectColumns} WHERE r.id = ?`).get(id);
  const currentRequest = (id) =>
    db.prepare("SELECT status, user_id, equipment_id, borrow_date FROM borrow_requests WHERE id = ?").get(id);
  const sendConflict = (res, err) => {
    if (err instanceof ConflictError) return res.status(err.status).json({ error: err.message });
    throw err;
  };

  router.get("/", (req, res) => {
    const status = req.query.status === undefined ? "pending" : req.query.status;
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: "Status must be pending, approved or rejected." });
    }
    const rows = db.prepare(`${selectColumns} WHERE r.status = ? ORDER BY r.id DESC`).all(status);
    const totals = Object.fromEntries(
      db.prepare("SELECT status, COUNT(*) AS n FROM borrow_requests GROUP BY status").all().map((row) => [row.status, row.n]),
    );
    const counts = Object.fromEntries(STATUSES.map((name) => [name, totals[name] ?? 0]));
    return res.json({ requests: rows.map(asAdminRequest), counts });
  });

  router.post("/:id/approve", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: "Request not found." });
    const request = findRequest(id);
    if (!request) return res.status(404).json({ error: "Request not found." });
    if (request.status !== "pending") return res.status(409).json({ error: "Only pending requests can be approved." });
    if (request.stock < 1) return res.status(409).json({ error: "This item is no longer available." });

    try {
      withTransaction(db, () => {
        const current = currentRequest(id);
        if (!current || current.status !== "pending") throw conflict("Only pending requests can be approved.");
        const equipment = db
          .prepare("SELECT id, name, location, quantity FROM equipment WHERE id = ?")
          .get(current.equipment_id);
        if (!equipment || equipment.quantity < 1) throw conflict("This item is no longer available.");
        const decidedAt = new Date().toISOString();
        db.prepare("UPDATE equipment SET quantity = quantity - 1, updated_at = ? WHERE id = ?").run(
          decidedAt,
          equipment.id,
        );
        const returnDate = addDaysISO(current.borrow_date, BORROW_MAX_DAYS);
        db.prepare(
          "UPDATE borrow_requests SET status = 'approved', return_date = ?, decided_by = ?, decided_at = ? WHERE id = ?",
        ).run(
          returnDate,
          req.user.id,
          decidedAt,
          id,
        );
        notify(db, {
          userId: current.user_id,
          type: "request_approved",
          message: `Request approved. ${equipment.name} is ready for pickup at ${equipment.location} on ${current.borrow_date}; return by ${returnDate}.`,
        });
      });
    } catch (err) {
      return sendConflict(res, err);
    }
    return res.json({ request: asAdminRequest(findRequest(id)) });
  });

  router.post("/:id/reject", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: "Request not found." });
    const reasonError = rejectionReasonError(req.body?.reason);
    if (reasonError) return res.status(400).json({ error: reasonError, fields: { reason: reasonError } });
    const reason = req.body.reason.trim();
    const request = findRequest(id);
    if (!request) return res.status(404).json({ error: "Request not found." });
    if (request.status !== "pending") return res.status(409).json({ error: "Only pending requests can be rejected." });

    try {
      withTransaction(db, () => {
        const current = currentRequest(id);
        if (!current || current.status !== "pending") throw conflict("Only pending requests can be rejected.");
        const equipment = db.prepare("SELECT name FROM equipment WHERE id = ?").get(current.equipment_id);
        const decidedAt = new Date().toISOString();
        db.prepare(
          "UPDATE borrow_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decision_reason = ? WHERE id = ?",
        ).run(req.user.id, decidedAt, reason, id);
        notify(db, {
          userId: current.user_id,
          type: "request_rejected",
          message: `Request rejected. ${equipment.name}. See the reason in My requests.`,
          reason,
        });
      });
    } catch (err) {
      return sendConflict(res, err);
    }
    return res.json({ request: asAdminRequest(findRequest(id)) });
  });

  router.post("/:id/return", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: "Request not found." });
    const request = findRequest(id);
    if (!request) return res.status(404).json({ error: "Request not found." });
    if (request.status !== "approved") {
      return res.status(409).json({ error: "Only approved loans can be marked returned." });
    }

    try {
      withTransaction(db, () => {
        const current = currentRequest(id);
        if (!current || current.status !== "approved") throw conflict("Only approved loans can be marked returned.");
        const returnedAt = new Date().toISOString();
        db.prepare("UPDATE borrow_requests SET status = 'returned', returned_at = ? WHERE id = ?").run(returnedAt, id);
        db.prepare("UPDATE equipment SET quantity = quantity + 1, updated_at = ? WHERE id = ?").run(
          returnedAt,
          current.equipment_id,
        );
        notify(db, {
          userId: current.user_id,
          type: "request_returned",
          message: `Equipment returned: ${request.equipment_name}.`,
          requestId: id,
        });
      });
    } catch (err) {
      return sendConflict(res, err);
    }
    return res.json({ request: asAdminRequest(findRequest(id)) });
  });

  return router;
}
