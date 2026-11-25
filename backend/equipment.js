import { Router } from "express";
import { requireAdmin } from "./auth.js";
import { equipmentInput } from "../shared/rules.js";

const selectColumns = "SELECT id, name, category, quantity, available FROM equipment";
const asEquipment = (row) => ({
  id: row.id,
  name: row.name,
  category: row.category,
  quantity: row.quantity,
  available: row.available,
});

export function equipmentRouter(db) {
  const router = Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // The catalogue is public so visitors can browse it before signing in.
  router.get("/", (req, res) => {
    const equipment = db
      .prepare(`${selectColumns} ORDER BY name COLLATE NOCASE, id`)
      .all()
      .map(asEquipment);
    res.json({ equipment });
  });

  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: "Equipment not found." });
    const row = db.prepare(`${selectColumns} WHERE id = ?`).get(id);
    return row ? res.json({ equipment: asEquipment(row) }) : res.status(404).json({ error: "Equipment not found." });
  });

  // Everything below this point may only be changed by administrators.
  router.use(requireAdmin(db));
  router.use((req, res, next) =>
    ["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json")
      ? res.status(415).json({ error: "JSON only." })
      : next(),
  );

  router.post("/", (req, res) => {
    const { fields, value } = equipmentInput(req.body);
    if (Object.keys(fields).length) return res.status(400).json({ error: "Please fix the fields below.", fields });

    const info = db
      .prepare("INSERT INTO equipment (name, category, quantity, available) VALUES (?, ?, ?, ?)")
      .run(value.name, value.category, value.quantity, value.quantity);
    const row = db.prepare(`${selectColumns} WHERE id = ?`).get(Number(info.lastInsertRowid));
    res.status(201).json({ equipment: asEquipment(row) });
  });

  router.put("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: "Equipment not found." });
    const existing = db.prepare("SELECT id FROM equipment WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "Equipment not found." });

    const { fields, value } = equipmentInput(req.body);
    if (Object.keys(fields).length) return res.status(400).json({ error: "Please fix the fields below.", fields });

    // The read above and the write below run with no await between them, so no approval or return can slip in.
    // Counting the approved loans, not quantity - available, keeps the shelf right even if available ever drifted.
    const onLoan = db
      .prepare("SELECT COUNT(*) AS n FROM borrow_requests WHERE equipment_id = ? AND status = 'approved'")
      .get(existing.id).n;
    if (value.quantity < onLoan) {
      const message = `Total cannot be lower than the ${onLoan} ${onLoan === 1 ? "item" : "items"} on loan.`;
      return res.status(400).json({ error: "Please fix the fields below.", fields: { quantity: message } });
    }
    db.prepare(
      "UPDATE equipment SET name = ?, category = ?, quantity = ?, available = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(value.name, value.category, value.quantity, value.quantity - onLoan, existing.id);
    const row = db.prepare(`${selectColumns} WHERE id = ?`).get(existing.id);
    res.json({ equipment: asEquipment(row) });
  });

  router.delete("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: "Equipment not found." });
    const existing = db.prepare("SELECT id FROM equipment WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "Equipment not found." });

    const linkedRequest = db.prepare("SELECT id FROM borrow_requests WHERE equipment_id = ? LIMIT 1").get(existing.id);
    if (linkedRequest) {
      return res.status(409).json({
        error: "Cannot delete equipment that has existing borrow requests.",
      });
    }

    db.prepare("DELETE FROM equipment WHERE id = ?").run(existing.id);
    res.status(204).end();
  });

  return router;
}
