import { Router } from "express";
import { requireAdmin } from "./auth.js";
import { todayISO } from "../shared/rules.js";

const selectOverdue = `
  SELECT r.id, r.equipment_id, e.name AS equipment_name, e.asset_id AS equipment_asset_id,
         e.category AS equipment_category, e.location AS equipment_location,
         r.user_id, u.full_name AS requester_name, u.email AS requester_email,
         r.borrow_date, r.return_date, r.purpose, r.created_at
  FROM borrow_requests r
  JOIN equipment e ON e.id = r.equipment_id
  JOIN users u ON u.id = r.user_id
  WHERE r.status = 'approved' AND r.return_date < ?
  ORDER BY r.return_date, r.id`;

const asOverdue = (row, today) => ({
  id: row.id,
  equipmentId: row.equipment_id,
  equipmentName: row.equipment_name,
  equipmentAssetId: row.equipment_asset_id,
  equipmentCategory: row.equipment_category,
  equipmentLocation: row.equipment_location,
  userId: row.user_id,
  requesterName: row.requester_name,
  requesterEmail: row.requester_email,
  borrowDate: row.borrow_date,
  returnDate: row.return_date,
  daysOverdue: Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.return_date}T00:00:00Z`)) / 86400000),
  purpose: row.purpose,
  createdAt: row.created_at,
});

export function overdueRouter(db) {
  const router = Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(requireAdmin(db));

  router.get("/", (req, res) => {
    const today = todayISO();
    const rows = db.prepare(selectOverdue).all(today);
    res.json({ overdue: rows.map((row) => asOverdue(row, today)), today });
  });

  return router;
}