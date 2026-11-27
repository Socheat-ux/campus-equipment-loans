import { Router } from "express";
import { requireRole } from "./auth.js";
import { isId, withTransaction } from "./db.js";
import { MESSAGE_MAX, notify, notifyAdmins } from "./notifications.js";
import { borrowRequestInput, todayISO } from "../shared/rules.js";

const selectColumns = `
  SELECT r.id, r.equipment_id, e.name AS equipment_name, e.category AS equipment_category,
         e.location AS equipment_location,
         r.user_id, r.borrow_date, r.return_date, r.purpose, r.status, r.created_at, r.decision_reason, r.returned_at
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
  returnedAt: row.returned_at,
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

  // The 409 answer for a second pending request on the same item.
  const duplicate = (res, equipment, existing) =>
    res.status(409).json({
      // A pending request whose start date has passed can no longer be approved, so waiting is pointless.
      error:
        existing.borrow_date < todayISO()
          ? `You already have a pending request for ${equipment.name} starting ${existing.borrow_date}. Its start date has passed, so cancel it in My requests and send a new one.`
          : `You already have a pending request for ${equipment.name} starting ${existing.borrow_date}. Cancel it in My requests or wait for a decision.`,
      existingRequestId: existing.id,
    });
  const findPending = (userId, equipmentId) =>
    db
      .prepare("SELECT id, borrow_date FROM borrow_requests WHERE user_id = ? AND equipment_id = ? AND status = 'pending' ORDER BY id LIMIT 1")
      .get(userId, equipmentId);

  router.get("/", async (req, res) => {
    const rows = await db
      .prepare(`${selectColumns} WHERE r.user_id = ? ORDER BY r.id DESC`)
      .all(req.user.id);
    res.json({ requests: rows.map(asRequest) });
  });

  router.get("/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!isId(id)) return res.status(404).json({ error: "Request not found." });
    const row = await db.prepare(`${selectColumns} WHERE r.id = ? AND r.user_id = ?`).get(id, req.user.id);
    return row ? res.json({ request: asRequest(row) }) : res.status(404).json({ error: "Request not found." });
  });

  router.post("/", async (req, res) => {
    const { fields, value } = borrowRequestInput(req.body);
    if (Object.keys(fields).length) return res.status(400).json({ error: "Please fix the fields below.", fields });

    const equipment = !isId(value.equipmentId) ? undefined : await db
      .prepare("SELECT id, name, available FROM equipment WHERE id = ?")
      .get(value.equipmentId);
    if (!equipment) return res.status(404).json({ error: "Equipment not found." });
    // The pre-check gives the usual answer; the borrow_requests_one_pending index settles two requests that race past it.
    const existing = await findPending(req.user.id, equipment.id);
    if (existing) return duplicate(res, equipment, existing);

    if (equipment.available < 1) {
      return res.status(400).json({
        error: "This item is no longer available.",
        fields: { equipmentId: "This item is no longer available." },
      });
    }

    let id;
    try {
      id = await withTransaction(db, async (tx) => {
        const info = await tx
          .prepare(
            `INSERT INTO borrow_requests
               (equipment_id, user_id, borrow_date, return_date, purpose, status)
             VALUES (?, ?, ?, ?, ?, 'pending') RETURNING id`,
          )
          .run(equipment.id, req.user.id, value.borrowDate, value.returnDate, value.purpose);
        const requestId = info.lastInsertRowid;
        const createdAt = (await tx.prepare("SELECT created_at FROM borrow_requests WHERE id = ?").get(requestId)).created_at;
        await notify(tx, {
          userId: req.user.id,
          type: "request_submitted",
          message: `Your request for ${equipment.name} was submitted and is awaiting approval.`,
          requestId,
          createdAt,
        });
        await notifyAdmins(tx, {
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
    } catch (err) {
      // The item was deleted after the lookup above (foreign key violation).
      if (err?.code === "23503") return res.status(404).json({ error: "Equipment not found." });
      // Unique violation: another request for this item got in first.
      if (err?.code !== "23505") throw err;
      const raced = await findPending(req.user.id, equipment.id);
      if (!raced) throw err;
      return duplicate(res, equipment, raced);
    }

    const row = await db.prepare(`${selectColumns} WHERE r.id = ?`).get(id);
    res.status(201).json({ request: asRequest(row) });
  });

  router.post("/:id/cancel", async (req, res) => {
    const id = Number(req.params.id);
    if (!isId(id)) return res.status(404).json({ error: "Request not found." });

    const row = await db.prepare(`${selectColumns} WHERE r.id = ? AND r.user_id = ?`).get(id, req.user.id);
    if (!row) return res.status(404).json({ error: "Request not found." });
    if (row.status !== "pending") return res.status(409).json({ error: "Only pending requests can be cancelled." });

    try {
      await withTransaction(db, async (tx) => {
        const current = await tx
          .prepare("SELECT status FROM borrow_requests WHERE id = ? AND user_id = ? FOR UPDATE")
          .get(id, req.user.id);
        if (!current || current.status !== "pending") {
          throw Object.assign(new Error("Only pending requests can be cancelled."), { status: 409 });
        }

        // Pending requests do not reserve stock, so cancelling them does not change equipment availability.
        const updated = await tx
          .prepare("UPDATE borrow_requests SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'")
          .run(id, req.user.id);
        if (!updated.changes) {
          throw Object.assign(new Error("Only pending requests can be cancelled."), { status: 409 });
        }

        await notify(tx, {
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

    const updatedRow = await db.prepare(`${selectColumns} WHERE r.id = ? AND r.user_id = ?`).get(id, req.user.id);
    return res.json({ request: asRequest(updatedRow) });
  });

  return router;
}
