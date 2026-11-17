# Campus Equipment Borrowing and Return Management System

A web system for borrowing and returning CADT equipment. Students and faculty sign in with their CADT email, browse equipment and send requests. Administrators approve requests and record returns.

## Sign in rules

- Students use `LastName.FirstName@student.cadt.edu.kh`, faculty use an address ending in `@cadt.edu.kh`.
- The role and the full name come from the email. `hong.bonsak@student.cadt.edu.kh` becomes "Hong Bonsak", in Southeast Asian order.
- Administrators are not created at signup.

## Run it

You need Node 22.16 or newer. From the repo root, the first time:

```
npm install
cp .env.example .env    # optional, the defaults work locally
npm run seed:test       # test accounts and a few sample items
npm run dev:all         # API on http://localhost:3000 and app on http://localhost:5173
```

Open http://localhost:5173 and sign in with a test account. `npm run dev:all` stops both servers on Ctrl+C. To run them in separate terminals instead, use `npm run dev:server` and `npm run dev`.

Run the tests with `npm test`. For a single-process build, run `npm run build` and then `npm start`.

`npm run seed:test` creates one account per role in `DB_PATH` (default `data/app.db`; the script reads `.env` too), all with the password `testpass123`: `test.student@student.cadt.edu.kh` (student), `test.faculty@cadt.edu.kh` (faculty) and `test.admin@cadt.edu.kh` (administrator). Running it again resets them. It adds sample equipment only when the catalogue is empty. It refuses to run when `NODE_ENV=production`, because the password is public.

Settings are environment variables, listed in `.env.example`: `PORT`, `DB_PATH`, `NODE_ENV` and `TRUST_PROXY`. The npm scripts read a `.env` file when there is one; variables already set in the shell or on the host win. Set `NODE_ENV=production` when deployed. Set `TRUST_PROXY=1` only behind a proxy you control.

## Equipment and administrators

Administrators manage equipment at `/equipment/new` and `/equipment/:id/edit`. The catalogue at `/` is public, and the dashboard at `/dashboard` lists the same equipment for every signed-in user, with search and filters. The API is mounted at `/api/equipment`: `GET` is public so visitors can browse the catalogue, while add and edit use `requireAdmin(db)`, so students and faculty get `403`.

Administrators are not created at signup. Promote an existing account directly in the database:

```
node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.env.DB_PATH || "data/app.db"); db.prepare("UPDATE users SET role = ? WHERE email = ?").run("admin", "lastname.firstname@cadt.edu.kh"); db.close();'
```

## Add to it

- Protect an API route with `requireAuth(db)` or `requireAdmin(db)` from `server/auth.js`. Both set `req.user` to `{ id, email, fullName, role }`.
- Share validation between the form and the server by adding it to `server/rules.js`, as `equipmentInput` does.
- Mount new routers in `server/app.js`, above the `/api` not-found handler.
- Wrap signed-in dashboard pages in `DashboardLayout` from `src/layouts/DashboardLayout.jsx`. It brings the sidebar, the top bar and log out. Add the route in `src/App.jsx` inside `<Gate>` (any signed-in user) or `<AdminGate>` (administrators only).
- Put tests directly in `server/` with a `.test.js` name, so `npm test` finds them.
- Send a user a notification with `notify(db, { userId, type, message, reason })` from `server/notifications.js`. A rejection needs a `reason`; a `reason` passed with an approval is ignored. The `message` can be up to 300 characters (`MESSAGE_MAX`) and the `reason` up to 500 (`REASON_MAX`). A too-long or empty `message` or `reason` makes `notify` throw, so the caller should check the administrator's reason first and answer 400. Call it inside `withTransaction(db, () => { ... })` from `server/db.js` (it throws a `TypeError` outside one), together with the change it reports, so both are saved or neither is. The function you pass must not be `async`. New kinds of notification go in `NOTIFICATION_TYPES`.

## Notifications

Signed-in users see a bell in the catalogue header and the dashboard top bar. It checks for new notifications every 30 seconds, shows the unread count, and marks the shown notifications as read when opened. The API is `GET /api/notifications` (the caller's 50 newest, plus the unread count) and `POST /api/notifications/read` with `{ "ids": [1, 2] }`, `{ "all": true }` or `{ "all": true, "upTo": 42 }`. `upTo` (a positive integer) limits "all" to notifications with `id <= upTo`, so the bell can mark everything it has shown without touching a notice that arrived after the last check. Any other body gets a 400, so a typo never marks everything read.

## Known limits

Email ownership is not verified at signup yet. The rate limiter is in memory, and the SQLite file may be wiped on hosts with a temporary disk.
