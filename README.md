# Campus Equipment Borrowing and Return Management System

A web system for borrowing and returning CADT equipment. Students and faculty sign in with their CADT email, browse equipment and send requests. Administrators approve requests and record returns.

## Sign in rules

- Students use `LastName.FirstName@student.cadt.edu.kh`, faculty use an address ending in `@cadt.edu.kh`.
- The role and the full name come from the email. `hong.bonsak@student.cadt.edu.kh` becomes "Hong Bonsak", in Southeast Asian order.
- Administrators are not created at signup. An existing administrator assigns that role later at `/users`.

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

Administrators manage equipment at `/equipment/new` and `/equipment/:id/edit`, and view each account's role at `/users`. The catalogue at `/` is public, and the dashboard at `/dashboard` lists the same equipment for every signed-in user, with search and filters. The API is mounted at `/api/equipment`: `GET` is public so visitors can browse the catalogue, while add and edit use `requireAdmin(db)`, so students and faculty get `403`.

## Viewing roles

The Users page at `/users` (also reachable from the Users item in the dashboard sidebar) lists accounts and marks each one with its role. It is read-only: there is no control to switch an account between student, faculty and admin. The page calls `GET /api/users`, which uses `requireAdmin(db)`: guests get `401`, students and faculty get `403`, and the response never includes password hashes.

Student and faculty roles come from the email address at signup. To grant the admin role, promote an account directly in the database as shown below. The `PATCH /api/users/:id/role` endpoint still exists for administrative scripts: it takes a JSON body such as `{ "role": "admin" }`, uses the same admin guard, accepts only `student`, `faculty` and `admin` (`400` otherwise), answers `404` for an unknown id and `415` for a non-JSON write, refuses to demote the last administrator, and takes effect on that user's next request.

Administrators are not created at signup. To create the very first one, promote an existing account directly in the database:

```
node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.env.DB_PATH || "data/app.db"); db.prepare("UPDATE users SET role = ? WHERE email = ?").run("admin", "lastname.firstname@cadt.edu.kh"); db.close();'
```

## Borrow requests

Students and faculty start a request from the catalogue button at `/requests/new?equipmentId=<id>`, or from the "My requests" link in the header. The form picks a borrow date from today onwards; the return date is always seven days later, calculated by the shared rules in `server/rules.js`, so a return date sent by the browser is ignored. A new request is `pending` and does not change the item's stock. The caller sees their requests at `/requests` and the submitted request at `/requests/:id/confirmation`.

The API is mounted at `/api/borrow-requests`: `GET /` lists the caller's requests, `GET /:id` returns one of their own, and `POST /` accepts `{ "equipmentId": 1, "borrowDate": "YYYY-MM-DD", "purpose": "Final year project" }` (`purpose` is optional). Students and faculty can use these routes; signed-out visitors get `401` and administrators get `403`. Submitting saves the request and `request_submitted` notifications for the borrower and every administrator in one transaction. An administrator's bell also backfills notices for older requests that were saved before their account existed, ordered by request date, without creating duplicates. Staff approval, rejection and returns are not wired up yet.

## Add to it

- Protect an API route with `requireAuth(db)` (any signed-in user) or `requireRole(db, "admin")` (only those roles; `requireRole(db, "student", "faculty")` works too) from `server/auth.js`. Both answer 401 without a session, `requireRole` answers 403 for other roles, and both set `req.user` to `{ id, email, fullName, role }`. A misspelt role name stops the server at startup. `requireAdmin(db)` is the same as `requireRole(db, "admin")`.
- List every new API route in `ROUTES` in `server/roles.test.js` with who may use it. The test fails until you do, and then checks the route answers 401 and 403 to the right people.
- Share validation between the form and the server by adding it to `server/rules.js`, as `equipmentInput` does.
- Mount new routers in `server/app.js`, above the `/api` not-found handler.
- Wrap signed-in dashboard pages in `DashboardLayout` from `src/layouts/DashboardLayout.jsx`. It brings the sidebar, the top bar and log out. Add the route in `src/App.jsx` inside `<RoleGate roles={["admin"]}>` (only those roles; list all three roles for any signed-in user). `<Gate>` is only for the log in and sign up pages, which signed-in users skip. With `RoleGate`, a signed-out visitor goes to the login page and comes back after signing in, and a signed-in user with another role sees a "not allowed" page. The browser check only decides what to show, so protect the matching API routes with `requireRole` too.
- Put tests directly in `server/` with a `.test.js` name, so `npm test` finds them.
- Send a user a notification with `notify(db, { userId, type, message, reason })` from `server/notifications.js`. A rejection needs a `reason`; a `reason` passed with an approval is ignored. The `message` can be up to 300 characters (`MESSAGE_MAX`) and the `reason` up to 500 (`REASON_MAX`). A too-long or empty `message` or `reason` makes `notify` throw, so the caller should check the administrator's reason first and answer 400. Call it inside `withTransaction(db, () => { ... })` from `server/db.js` (it throws a `TypeError` outside one), together with the change it reports, so both are saved or neither is. The function you pass must not be `async`. New kinds of notification go in `NOTIFICATION_TYPES`.

## Roles

There are three roles: `student`, `faculty` and `admin` (listed in `ROLES` in `server/rules.js`). Students and faculty use the catalogue and their own `/requests` pages. Only administrators can open `/dashboard`, `/users`, `/equipment/new` and `/equipment/:id/edit`, and only they see the Dashboard link. The others get a "not allowed" page with a way back to the catalogue. The Users page shows these roles as read-only marks; `ROLES` in `server/rules.js` is the shared list of allowed values.

## Notifications

Signed-in users see a bell in the catalogue header and the dashboard top bar. It checks for new notifications every 30 seconds, shows the unread count, and marks the shown notifications as read when opened. The API is `GET /api/notifications` (the caller's 50 newest, plus the unread count), `POST /api/notifications/read` with `{ "ids": [1, 2] }`, `{ "all": true }` or `{ "all": true, "upTo": 42 }`, `POST /api/notifications/:id/read` for one notice and `POST /api/notifications/read-all` for every notice. `upTo` (a positive integer) limits "all" to notifications with `id <= upTo`, so the bell can mark everything it has shown without touching a notice that arrived after the last check. Any other body gets a 400, so a typo never marks everything read.

## Known limits

Email ownership is not verified at signup yet. The rate limiter is in memory, and the SQLite file may be wiped on hosts with a temporary disk.
