import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { authRouter } from "./auth.js";
import { equipmentRouter } from "./equipment.js";
import { borrowRequestsRouter } from "./borrowRequests.js";
import { adminBorrowRequestsRouter } from "./adminBorrowRequests.js";
import { notificationsRouter } from "./notifications.js";
import { overdueRouter } from "./overdue.js";
import { usersRouter } from "./users.js";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

export function createApp(db, options) {
  const app = express();
  app.disable("x-powered-by");
  // Express 5 defaults to the simple parser; bracket keys such as item[x]=1 must still arrive as objects so filters can refuse them.
  app.set("query parser", "extended");
  // Off unless TRUST_PROXY is a hop count: with no proxy in front, a client could fake X-Forwarded-For and dodge the rate limit.
  const hops = Number(process.env.TRUST_PROXY);
  if (hops > 0) app.set("trust proxy", hops);
  app.use((req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" });
    next();
  });
  app.use(express.json({ limit: "10kb" }));

  app.use("/api/auth", authRouter(db, options));
  app.use("/api/equipment", equipmentRouter(db));
  app.use("/api/borrow-requests", borrowRequestsRouter(db));
  app.use("/api/admin/borrow-requests", adminBorrowRequestsRouter(db));
  app.use("/api/notifications", notificationsRouter(db));
  app.use("/api/admin/overdue", overdueRouter(db));
  app.use("/api/users", usersRouter(db));
  // Mount new API routers above this line, so unknown /api paths still answer with JSON.
  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get("/{*path}", (req, res) => res.sendFile(join(dist, "index.html")));
  }

  app.use((err, req, res, next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? "Server error." : "Bad request." });
  });
  return app;
}
