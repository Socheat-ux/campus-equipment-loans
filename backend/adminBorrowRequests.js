import { Router } from "express";
import { requireAdmin } from "./auth.js";
import { isId, withTransaction } from "./db.js";
import { notify } from "./notifications.js";
import { addDaysISO, BORROW_MAX_DAYS, hasControlChars, parseISODate, rejectionReasonError, todayISO } from "../shared/rules.js";

// Approving after the start date would create a loan that is already late, so the admin rejects instead.
const START_PASSED = "The start date has passed. Reject this request so the student can send a new one.";
// A student promoted to admin keeps their requests; someone else has to decide on them.
const OWN_REQUEST = "You cannot approve your own request. Another administrator must decide on it.";

const STATUSES = ["pending", "approved", "rejected", "returned", "cancelled"];
const SEARCH_MAX = 100;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const selectColumns = `
  SELECT r.id, r.equipment_id, e.name AS equipment_name, e.asset_id AS equipment_asset_id,
         e.location AS equipment_location, e.available AS stock, e.quantity AS total,
         r.user_id, u.full_name AS requester_name, u.email AS requester_email, u.role AS requester_role,
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
  total: row.total,
  userId: row.user_id,
  requesterName: row.requester_name,
  requesterEmail: row.requester_email,
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
const forbidden = (message) => Object.assign(new ConflictError(message), { status: 403 });

// ILIKE treats % and _ as wildcards, so a search for "50%" escapes them with "!".
const contains = (text) => `%${text.replace(/[!%_]/g, (c) => `!${c}`)}%`;

// Turns the list's query string into a WHERE clause. Every value is bound, never pasted into the SQL.
// status: one status or "all" (default "pending"); from and to: borrow date range, inclusive;
// item: part of the item name or asset ID; borrower: part of the full name or email.
export function historyFilter(query) {
  const value = (name) => query[name] ?? "";
  for (const name of ["status", "from", "to", "item", "borrower"]) {
    if (typeof value(name) !== "string") return { error: `Use ${name} once.` };
  }
  const status = value("status") || "pending";
  if (status !== "all" && !STATUSES.includes(status)) {
    return { error: "Status must be pending, approved, rejected, returned, cancelled or all." };
  }
  const from = value("from");
  const to = value("to");
  if (from && !parseISODate(from)) return { error: "From must be a date like 2026-11-01." };
  if (to && !parseISODate(to)) return { error: "To must be a date like 2026-11-30." };
  if (from && to && from > to) return { error: "From must be on or before To." };
  const item = value("item").trim();
  const borrower = value("borrower").trim();
  if (item.length > SEARCH_MAX || borrower.length > SEARCH_MAX) {
    return { error: `Searches must be ${SEARCH_MAX} characters or fewer.` };
  }
  // A NUL would make ILIKE match every row, so control characters are refused.
  if (CONTROL_CHARS.test(item) || CONTROL_CHARS.test(borrower)) return { error: "Searches cannot contain control characters." };

  const where = [];
  const params = [];
  const add = (sql, ...values) => {
    where.push(sql);
    params.push(...values);
  };
  if (status !== "all") add("r.status = ?", status);
  if (from) add("r.borrow_date >= ?", from);
  if (to) add("r.borrow_date <= ?", to);
  // Postgres LIKE is case-sensitive, so the searches use ILIKE to ignore case.
  if (item) add("(e.name ILIKE ? ESCAPE '!' OR e.asset_id ILIKE ? ESCAPE '!')", contains(item), contains(item));
  if (borrower) add("(u.full_name ILIKE ? ESCAPE '!' OR u.email ILIKE ? ESCAPE '!')", contains(borrower), contains(borrower));
  return { where: where.length ? where.join(" AND ") : "1 = 1", params };
}

// A cell that starts with = + - @ (also full-width, and after spaces or invisible characters) or with a tab or
// carriage return would run as a formula in a spreadsheet, so it gets a leading apostrophe.
// Cells with commas, quotes or line breaks are quoted (RFC 4180).
export function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\s\u200b]*[=+\-@＝＋－＠]|^[\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Reports are read in Cambodia, so timestamps and the file date use Phnom Penh time whatever the server's zone is.
const PHNOM_PENH = { timeZone: "Asia/Phnom_Penh" };
const phnomPenhDate = (date = new Date()) => date.toLocaleDateString("sv-SE", PHNOM_PENH);
const phnomPenhDateTime = (iso) => {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return iso ?? "";
  return date.toLocaleString("sv-SE", { ...PHNOM_PENH, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const CSV_COLUMNS = [
  ["Request ID", (r) => r.id],
  ["Item", (r) => r.equipmentName],
  ["Asset ID", (r) => r.equipmentAssetId],
  ["Borrower", (r) => r.requesterName],
  ["Email", (r) => r.requesterEmail],
  ["Borrow date", (r) => r.borrowDate],
  ["Due date", (r) => r.returnDate],
  ["Returned date", (r) => phnomPenhDateTime(r.returnedAt)],
  ["Status", (r) => r.status],
];

export function adminBorrowRequestsRouter(db) {
  const router = Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(requireAdmin(db));

  const findRequest = (id) => db.prepare(`${selectColumns} WHERE r.id = ?`).get(id);
  // Inside a transaction: locks the request row, so two admins acting on it at once take turns.
  const lockRequest = (tx, id) =>
    tx.prepare("SELECT status, user_id, equipment_id, borrow_date FROM borrow_requests WHERE id = ? FOR UPDATE").get(id);
  const sendConflict = (res, err) => {
    if (err instanceof ConflictError) return res.status(err.status).json({ error: err.message });
    throw err;
  };

  // shortcut: no paging, every matching row is returned; add LIMIT and OFFSET if a term grows past a few thousand loans.
  const findHistory = async ({ where, params }) =>
    (await db.prepare(`${selectColumns} WHERE ${where} ORDER BY r.id DESC`).all(...params)).map(asAdminRequest);

  router.get("/", async (req, res) => {
    const filter = historyFilter(req.query);
    if (filter.error) return res.status(400).json({ error: filter.error });
    const rows = await findHistory(filter);
    const totals = Object.fromEntries(
      (await db.prepare("SELECT status, COUNT(*)::int AS n FROM borrow_requests GROUP BY status").all()).map((row) => [row.status, row.n]),
    );
    const counts = Object.fromEntries(STATUSES.map((name) => [name, totals[name] ?? 0]));
    return res.json({ requests: rows, counts, today: todayISO(), viewerId: req.user.id });
  });

  // The same filters as the list, so the file holds exactly the rows the admin is looking at.
  router.get("/export.csv", async (req, res) => {
    const filter = historyFilter(req.query);
    if (filter.error) return res.status(400).json({ error: filter.error });
    const lines = [CSV_COLUMNS.map(([title]) => title), ...(await findHistory(filter)).map((r) => CSV_COLUMNS.map(([, cell]) => cell(r)))];
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="borrowing-report-${phnomPenhDate()}.csv"`);
    // The byte order mark makes Excel read the file as UTF-8.
    return res.send(`\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`);
  });

  router.post("/:id/approve", async (req, res) => {
    const id = Number(req.params.id);
    if (!isId(id)) return res.status(404).json({ error: "Request not found." });
    const request = await findRequest(id);
    if (!request) return res.status(404).json({ error: "Request not found." });
    if (request.user_id === req.user.id) return res.status(403).json({ error: OWN_REQUEST });
    if (request.status !== "pending") return res.status(409).json({ error: "Only pending requests can be approved." });
    if (request.borrow_date < todayISO()) return res.status(409).json({ error: START_PASSED });
    if (request.stock < 1) return res.status(409).json({ error: "This item is no longer available." });

    try {
      await withTransaction(db, async (tx) => {
        const current = await lockRequest(tx, id);
        if (!current || current.status !== "pending") throw conflict("Only pending requests can be approved.");
        if (current.user_id === req.user.id) throw forbidden(OWN_REQUEST);
        if (current.borrow_date < todayISO()) throw conflict(START_PASSED);
        const equipment = await tx
          .prepare("SELECT id, name, location, available FROM equipment WHERE id = ? FOR NO KEY UPDATE")
          .get(current.equipment_id);
        if (!equipment || equipment.available < 1) throw conflict("This item is no longer available.");
        const decidedAt = new Date().toISOString();
        await tx.prepare("UPDATE equipment SET available = available - 1, updated_at = ? WHERE id = ?").run(
          decidedAt,
          equipment.id,
        );
        const returnDate = addDaysISO(current.borrow_date, BORROW_MAX_DAYS);
        await tx.prepare(
          "UPDATE borrow_requests SET status = 'approved', return_date = ?, decided_by = ?, decided_at = ? WHERE id = ?",
        ).run(
          returnDate,
          req.user.id,
          decidedAt,
          id,
        );
        await notify(tx, {
          userId: current.user_id,
          type: "request_approved",
          message: `Request approved. ${equipment.name} is ready for pickup at ${equipment.location} on ${current.borrow_date}; return by ${returnDate}.`,
        });
      });
    } catch (err) {
      return sendConflict(res, err);
    }
    return res.json({ request: asAdminRequest(await findRequest(id)) });
  });

  router.post("/:id/reject", async (req, res) => {
    const id = Number(req.params.id);
    if (!isId(id)) return res.status(404).json({ error: "Request not found." });
    const reasonError = rejectionReasonError(req.body?.reason);
    if (reasonError) return res.status(400).json({ error: reasonError, fields: { reason: reasonError } });
    const reason = req.body.reason.trim();
    const request = await findRequest(id);
    if (!request) return res.status(404).json({ error: "Request not found." });
    if (request.status !== "pending") return res.status(409).json({ error: "Only pending requests can be rejected." });

    try {
      await withTransaction(db, async (tx) => {
        const current = await lockRequest(tx, id);
        if (!current || current.status !== "pending") throw conflict("Only pending requests can be rejected.");
        const equipment = await tx.prepare("SELECT name FROM equipment WHERE id = ? FOR NO KEY UPDATE").get(current.equipment_id);
        const decidedAt = new Date().toISOString();
        await tx.prepare(
          "UPDATE borrow_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decision_reason = ? WHERE id = ?",
        ).run(req.user.id, decidedAt, reason, id);
        await notify(tx, {
          userId: current.user_id,
          type: "request_rejected",
          message: `Request rejected. ${equipment.name}. See the reason in My requests.`,
          reason,
        });
      });
    } catch (err) {
      return sendConflict(res, err);
    }
    return res.json({ request: asAdminRequest(await findRequest(id)) });
  });

  router.post("/:id/return", async (req, res) => {
    const id = Number(req.params.id);
    if (!isId(id)) return res.status(404).json({ error: "Request not found." });
    const request = await findRequest(id);
    if (!request) return res.status(404).json({ error: "Request not found." });
    if (request.status !== "approved") {
      return res.status(409).json({ error: "Only approved loans can be marked returned." });
    }
    try {
      await withTransaction(db, async (tx) => {
        const current = await lockRequest(tx, id);
        if (!current || current.status !== "approved") throw conflict("Only approved loans can be marked returned.");
        await tx.prepare("SELECT id FROM equipment WHERE id = ? FOR NO KEY UPDATE").get(current.equipment_id);
        // LEAST: a returned item is always recorded, and stock never goes above what the store owns.
        const returnedAt = new Date().toISOString();
        await tx.prepare("UPDATE borrow_requests SET status = 'returned', returned_at = ? WHERE id = ?").run(returnedAt, id);
        await tx.prepare("UPDATE equipment SET available = LEAST(available + 1, quantity), updated_at = ? WHERE id = ?").run(returnedAt, current.equipment_id);
        await notify(tx, {
          userId: current.user_id,
          type: "request_returned",
          message: `Equipment returned: ${request.equipment_name}.`,
          requestId: id,
        });
      });
    } catch (err) {
      return sendConflict(res, err);
    }
    return res.json({ request: asAdminRequest(await findRequest(id)) });
  });

  router.post("/:id/cancel", async (req, res) => {
    const id = Number(req.params.id);
    if (!isId(id)) return res.status(404).json({ error: "Request not found." });
    const request = await findRequest(id);
    if (!request) return res.status(404).json({ error: "Request not found." });
    if (!["approved", "rejected"].includes(request.status)) {
      return res.status(409).json({ error: "Only approved or rejected requests can be cancelled by admin." });
    }
    const reasonRaw = req.body?.reason;
    const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
    if (reasonRaw !== undefined && reasonRaw !== null && reason.length > 300) {
      return res.status(400).json({
        error: "Reason must be 300 characters or fewer.",
        fields: { reason: "Reason must be 300 characters or fewer." },
      });
    }
    if (hasControlChars(reason)) {
      return res.status(400).json({
        error: "Reason cannot contain control characters.",
        fields: { reason: "Reason cannot contain control characters." },
      });
    }
    try {
      await withTransaction(db, async (tx) => {
        const current = await lockRequest(tx, id);
        if (!current || !["approved", "rejected"].includes(current.status)) {
          throw conflict("Only approved or rejected requests can be cancelled by admin.");
        }
        await tx.prepare("SELECT id FROM equipment WHERE id = ? FOR NO KEY UPDATE").get(current.equipment_id);
        const decidedAt = new Date().toISOString();
        if (current.status === "approved") {
          await tx.prepare("UPDATE equipment SET available = LEAST(available + 1, quantity), updated_at = ? WHERE id = ?").run(
            decidedAt,
            current.equipment_id,
          );
        }
        await tx.prepare(
          "UPDATE borrow_requests SET status = 'cancelled', decided_by = ?, decided_at = ?, decision_reason = ? WHERE id = ?",
        ).run(req.user.id, decidedAt, reason || null, id);
        const reasonText = reason ? ` Reason: ${reason}` : "";
        await notify(tx, {
          userId: current.user_id,
          type: "request_cancelled",
          message: `Your request for ${request.equipment_name} was cancelled by an administrator.${reasonText}`.slice(0, 300),
          requestId: id,
        });
      });
    } catch (err) {
      return sendConflict(res, err);
    }
    return res.json({ request: asAdminRequest(await findRequest(id)) });
  });

  return router;
}
