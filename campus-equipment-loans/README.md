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

## Add to it

- Protect an API route with `requireAuth(db)` from `server/auth.js`. It sets `req.user` to `{ id, email, fullName, role }`.
- Mount new routers in `server/app.js`, above the `/api` not-found handler.
- Start every signed-in page with `<AppHeader />` from `src/pages/Home.jsx`.

## Known limits

Email ownership is not verified at signup yet. The rate limiter is in memory, and the SQLite file may be wiped on hosts with a temporary disk.
