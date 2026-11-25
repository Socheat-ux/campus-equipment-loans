import { Router } from "express";
import { requireAdmin } from "./auth.js";
import { roleError } from "../shared/rules.js";

const selectColumns = "SELECT id, email, full_name AS fullName, role, created_at AS createdAt FROM users";
const asUser = (row) => ({
  id: row.id,
  email: row.email,
  fullName: row.fullName,
  role: row.role,
  createdAt: row.createdAt,
});

export function usersRouter(db) {
  const router = Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // Listing accounts and changing anyone's role is administration: 401 without a session, 403 for other roles.
  router.use(requireAdmin(db));

  router.get("/", (req, res) => {
    const users = db
      .prepare(`${selectColumns} ORDER BY full_name COLLATE NOCASE, id`)
      .all()
      .map(asUser);
    res.json({ users });
  });

  router.use((req, res, next) =>
    ["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json")
      ? res.status(415).json({ error: "JSON only." })
      : next(),
  );

  router.patch("/:id/role", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: "User not found." });
    const existing = db.prepare("SELECT id, role FROM users WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "User not found." });

    const problem = roleError(req.body?.role);
    if (problem) return res.status(400).json({ error: "Please choose a valid role.", fields: { role: problem } });
    const role = req.body.role;

    // Do not let the last administrator lock everyone out of this page (and every other admin page).
    if (existing.role === "admin" && role !== "admin") {
      const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
      if (admins <= 1) return res.status(409).json({ error: "At least one administrator must remain." });
    }

    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
    const row = db.prepare(`${selectColumns} WHERE id = ?`).get(id);
    res.json({ user: asUser(row) });
  });

  return router;
}
