import { openDb } from "./db.js";
import { createApp } from "./app.js";

if (process.env.NODE_ENV !== "production") {
  console.warn("WARNING: NODE_ENV is not production, so the session cookie is not marked Secure. Set NODE_ENV=production when deployed.");
}
const port = Number(process.env.PORT) || 3000;
const db = await openDb(process.env.DATABASE_URL || process.env.PGDATA_DIR || "data/pgdata");
createApp(db).listen(port, () => console.log(`Campus Equipment Loans on http://localhost:${port}`));
