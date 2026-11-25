import { Router } from "express";
import { requireAdmin } from "./auth.js";
import { isId, withTransaction } from "./db.js";
import { roleError } from "../shared/rules.js";

const selectColumns = `SELECT id, email, full_name AS "fullName", role, created_at AS "createdAt" FROM users`;
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

  router.get("/", async (req, res) => {
    const users = (await db.prepare(`${selectColumns} ORDER BY lower(full_name), id`).all()).map(asUser);
    res.json({ users });
  });

  router.use((req, res, next) =>
    ["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json")
      ? res.status(415).json({ error: "JSON only." })
      : next(),
  );

  router.patch("/:id/role", async (req, res) => {
    const id = Number(req.params.id);
    if (!isId(id)) return res.status(404).json({ error: "User not found." });
    const existing = await db.prepare("SELECT id, role FROM users WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "User not found." });

    const problem = roleError(req.body?.role);
    if (problem) return res.status(400).json({ error: "Please choose a valid role.", fields: { role: problem } });
    const role = req.body.role;

    // Do not let the last administrator lock everyone out of this page (and every other admin page).
    // The admin rows stay locked until the update is written, so two admins demoting each other at once take turns:
    // the second one then sees one administrator left and is refused. The role is read again after the lock.
    const outcome = await withTransaction(db, async (tx) => {
      const admins = (await tx.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id FOR UPDATE").all()).length;
      const current = await tx.prepare("SELECT role FROM users WHERE id = ? FOR UPDATE").get(id);
      if (!current) return { status: 404, body: { error: "User not found." } };
      if (current.role === "admin" && role !== "admin" && admins <= 1) {
        return { status: 409, body: { error: "At least one administrator must remain." } };
      }
      await tx.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
      const row = await tx.prepare(`${selectColumns} WHERE id = ?`).get(id);
      return { status: 200, body: { user: asUser(row) } };
    });
    res.status(outcome.status).json(outcome.body);
  });

  return router;
}
