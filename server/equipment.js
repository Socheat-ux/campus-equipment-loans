import { Router } from "express";
import { requireAdmin, requireAuth } from "./auth.js";
import { equipmentInput } from "./rules.js";

const selectColumns = "SELECT id, name, category, quantity FROM equipment";
const asEquipment = (row) => ({ id: row.id, name: row.name, category: row.category, quantity: row.quantity });

export function equipmentRouter(db) {
  const router = Router();

  // Any signed-in user may read the catalogue; only administrators may change it.
  router.use(requireAuth(db));
  router.use((req, res, next) => (req.method === "GET" ? next() : requireAdmin(db)(req, res, next)));
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use((req, res, next) =>
    ["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json")
      ? res.status(415).json({ error: "JSON only." })
      : next(),
  );

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

  router.post("/", (req, res) => {
    const { fields, value } = equipmentInput(req.body);
    if (Object.keys(fields).length) return res.status(400).json({ error: "Please fix the fields below.", fields });

    const info = db
      .prepare("INSERT INTO equipment (name, category, quantity) VALUES (?, ?, ?)")
      .run(value.name, value.category, value.quantity);
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

    db.prepare(
      "UPDATE equipment SET name = ?, category = ?, quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(value.name, value.category, value.quantity, existing.id);
    const row = db.prepare(`${selectColumns} WHERE id = ?`).get(existing.id);
    res.json({ equipment: asEquipment(row) });
  });

  return router;
}
