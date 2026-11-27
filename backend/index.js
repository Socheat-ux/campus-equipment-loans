import { isPostgresUrl, openDb } from "./db.js";
import { createApp } from "./app.js";

const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
if (process.env.NODE_ENV !== "production") {
  console.warn("WARNING: NODE_ENV is not production, so the session cookie is not marked Secure. Set NODE_ENV=production when deployed.");
}
// A value that is not a postgres URL would otherwise be used as a PGlite folder name; in production it would quietly run on
// a disk nobody backs up. Unset is fine outside production (local PGlite).
if (databaseUrl ? !isPostgresUrl(databaseUrl) : process.env.NODE_ENV === "production") {
  console.error("DATABASE_URL is missing or is not a postgres:// or postgresql:// URL. With NODE_ENV=production the server needs it; elsewhere leave it unset. The server will not start.");
  process.exit(1);
}
const port = Number(process.env.PORT) || 3000;
const db = await openDb(databaseUrl || process.env.PGDATA_DIR || "data/pgdata");
createApp(db).listen(port, () => console.log(`Campus Equipment Loans on http://localhost:${port}`));
