import { Router } from "express";
import { requireAdmin } from "./auth.js";
import { isId, withTransaction } from "./db.js";
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
  router.get("/", async (req, res) => {
    const equipment = (await db.prepare(`${selectColumns} ORDER BY lower(name), id`).all()).map(asEquipment);
    res.json({ equipment });
  });

  router.get("/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!isId(id)) return res.status(404).json({ error: "Equipment not found." });
    const row = await db.prepare(`${selectColumns} WHERE id = ?`).get(id);
    return row ? res.json({ equipment: asEquipment(row) }) : res.status(404).json({ error: "Equipment not found." });
  });

  // Everything below this point may only be changed by administrators.
  router.use(requireAdmin(db));
  router.use((req, res, next) =>
    ["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json")
      ? res.status(415).json({ error: "JSON only." })
      : next(),
  );

  router.post("/", async (req, res) => {
    const { fields, value } = equipmentInput(req.body);
    if (Object.keys(fields).length) return res.status(400).json({ error: "Please fix the fields below.", fields });

    const info = await db
      .prepare("INSERT INTO equipment (name, category, quantity, available) VALUES (?, ?, ?, ?) RETURNING id")
      .run(value.name, value.category, value.quantity, value.quantity);
    const row = await db.prepare(`${selectColumns} WHERE id = ?`).get(info.lastInsertRowid);
    res.status(201).json({ equipment: asEquipment(row) });
  });

  router.put("/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!isId(id)) return res.status(404).json({ error: "Equipment not found." });
    const { fields, value } = equipmentInput(req.body);

    // The row lock keeps approvals and returns on this item waiting until the new total and shelf count are written.
    // Counting the approved loans, not quantity - available, keeps the shelf right even if available ever drifted.
    const outcome = await withTransaction(db, async (db) => {
      const existing = await db.prepare("SELECT id FROM equipment WHERE id = ? FOR UPDATE").get(id);
      if (!existing) return { status: 404, body: { error: "Equipment not found." } };
      if (Object.keys(fields).length) return { status: 400, body: { error: "Please fix the fields below.", fields } };
      const { n: onLoan } = await db
        .prepare("SELECT COUNT(*)::int AS n FROM borrow_requests WHERE equipment_id = ? AND status = 'approved'")
        .get(existing.id);
      if (value.quantity < onLoan) {
        const message = `Total cannot be lower than the ${onLoan} ${onLoan === 1 ? "item" : "items"} on loan.`;
        return { status: 400, body: { error: "Please fix the fields below.", fields: { quantity: message } } };
      }
      await db
        .prepare(
          "UPDATE equipment SET name = ?, category = ?, quantity = ?, available = ?, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?",
        )
        .run(value.name, value.category, value.quantity, value.quantity - onLoan, existing.id);
      return { status: 200, body: { equipment: asEquipment(await db.prepare(`${selectColumns} WHERE id = ?`).get(existing.id)) } };
    });
    res.status(outcome.status).json(outcome.body);
  });

  router.delete("/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!isId(id)) return res.status(404).json({ error: "Equipment not found." });
    const existing = await db.prepare("SELECT id FROM equipment WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "Equipment not found." });

    const linkedRequest = await db.prepare("SELECT id FROM borrow_requests WHERE equipment_id = ? LIMIT 1").get(existing.id);
    if (linkedRequest) {
      return res.status(409).json({
        error: "Cannot delete equipment that has existing borrow requests.",
      });
    }

    await db.prepare("DELETE FROM equipment WHERE id = ?").run(existing.id);
    res.status(204).end();
  });

  return router;
}
