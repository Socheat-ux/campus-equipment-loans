# Campus Equipment Borrowing and Return Management System

A web system for borrowing and returning CADT equipment. Students and faculty sign in with their CADT email, browse equipment and send requests. Administrators approve requests and record returns.

## Sign in rules

- Students use `LastName.FirstName@student.cadt.edu.kh`, faculty use an address ending in `@cadt.edu.kh`.
- The role and the full name come from the email. `hong.bonsak@student.cadt.edu.kh` becomes "Hong Bonsak", in Southeast Asian order.
- Administrators are not created at signup.

## Run it

You need Node 22.13 or newer. From the repo root:

```
npm install
npm run dev:server    # API on http://localhost:3000
npm run dev           # app on http://localhost:5173
```

Run the tests with `npm test`. For a single-process build, run `npm run build` and then `npm start`.

Settings are environment variables, listed in `.env.example`: `PORT`, `DB_PATH`, `NODE_ENV` and `TRUST_PROXY`. Set `NODE_ENV=production` when deployed. Set `TRUST_PROXY=1` only behind a proxy you control.

## Equipment and administrators

Administrators manage equipment at `/equipment/new` and `/equipment/:id/edit`. The API is mounted at `/api/equipment` and every route uses `requireAdmin(db)`, so students and faculty get `403`.

Administrators are not created at signup. Promote an existing account directly in the database:

```
node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.env.DB_PATH || "data/app.db"); db.prepare("UPDATE users SET role = ? WHERE email = ?").run("admin", "lastname.firstname@cadt.edu.kh"); db.close();'
```

## Add to it

- Protect an API route with `requireAuth(db)` or `requireAdmin(db)` from `server/auth.js`. Both set `req.user` to `{ id, email, fullName, role }`.
- Share validation between the form and the server by adding it to `server/rules.js`, as `equipmentInput` does.
- Mount new routers in `server/app.js`, above the `/api` not-found handler.
- Start every signed-in page with `<AppHeader />` from `src/pages/Home.jsx`.

## Known limits

Email ownership is not verified at signup yet. The rate limiter is in memory, and the SQLite file may be wiped on hosts with a temporary disk.
