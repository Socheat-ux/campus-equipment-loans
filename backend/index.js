import { openDb } from "./db.js";
import { createApp } from "./app.js";

const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
if (process.env.NODE_ENV !== "production") {
  console.warn("WARNING: NODE_ENV is not production, so the session cookie is not marked Secure. Set NODE_ENV=production when deployed.");
} else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
  // Anything else would make openDb fall back to a PGlite folder on the host's disk and quietly run on data nobody backs up.
  console.error("DATABASE_URL is missing or is not a postgres:// URL. With NODE_ENV=production the server needs it, so it will not start.");
  process.exit(1);
}
const port = Number(process.env.PORT) || 3000;
const db = await openDb(databaseUrl || process.env.PGDATA_DIR || "data/pgdata");
createApp(db).listen(port, () => console.log(`Campus Equipment Loans on http://localhost:${port}`));
