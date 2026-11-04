import { Router } from "express";
import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { roleFor, displayName, passwordError, EMAIL_HELP } from "./rules.js";

const scryptAsync = promisify(scrypt);
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Parameters travel with the hash, so they can be raised later without breaking old accounts. N=32768, r=8, p=3 is about 32 MiB.
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

async function hashPassword(pw) {
  const salt = randomBytes(16);
  const { N, r, p, maxmem } = SCRYPT;
  const key = await scryptAsync(pw.normalize("NFC"), salt, 64, { N, r, p, maxmem });
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function checkPassword(pw, stored) {
  const [, N, r, p, salt, key] = stored.split("$");
  const expected = Buffer.from(key, "hex");
  const actual = await scryptAsync(pw.normalize("NFC"), Buffer.from(salt, "hex"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(actual, expected);
}

// Checked against when the email is unknown, so a missing account takes as long as a wrong password.
const DUMMY_HASH = await hashPassword("not-a-real-password-1");

const readSid = (req) => /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? null;

function startSession(db, res, userId, maxSessions) {
  const token = randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
    sha256(token),
    userId,
    Date.now() + SESSION_MS,
  );
  // Keep only the newest few per user, so a login loop cannot grow the table.
  db.prepare(
    "DELETE FROM sessions WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT ?)",
  ).run(userId, userId, maxSessions);
  res.cookie("sid", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MS,
    path: "/",
  });
}

export function sessionUser(db, req) {
  const sid = readSid(req);
  if (!sid) return null;
  return (
    db
      .prepare(
        `SELECT u.id, u.email, u.full_name AS fullName, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(sha256(sid), Date.now()) ?? null
  );
}

// Use on any route that needs a signed-in user: router.get("/x", requireAuth(db), handler).
export const requireAuth = (db) => (req, res, next) => {
  req.user = sessionUser(db, req);
  return req.user ? next() : res.status(401).json({ error: "Please log in." });
};

// Use on any route that only administrators may call: router.use(requireAdmin(db)).
export const requireAdmin = (db) => (req, res, next) => {
  req.user = sessionUser(db, req);
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Administrators only." });
  next();
};

// Limiter key for an address: IPv4 and IPv4-mapped IPv6 stay the IPv4 address, other IPv6 is grouped by its /64 (one host or LAN owns a whole /64).
export function ipKey(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("%")[0].split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

export function authRouter(
  db,
  {
    ipFailures = 300, // tries per address, shared by signup and login; a whole campus can sit behind one address
    accountFailures = 10, // tries per address and email
    emailFailures = 30, // tries per email from all addresses together
    ipSuccesses = 100, // successful signups and logins per address
    maxKeys = 10000,
    maxSessionsPerUser = 10,
    windowMs = 15 * 60 * 1000,
    scryptConcurrency = 2, // scrypt runs on the libuv pool shared with file serving, so leave threads free
  } = {},
) {
  // Defaults only cover undefined, so null, NaN, 0 and negatives would otherwise fail later in odd ways.
  for (const [name, v] of Object.entries({ ipFailures, accountFailures, emailFailures, ipSuccesses, maxKeys, maxSessionsPerUser, windowMs, scryptConcurrency })) {
    if (!Number.isInteger(v) || v < 1) throw new TypeError(`authRouter option ${name} must be a positive integer, got ${v}`);
  }
  const router = Router();

  // shortcut: in memory and per process, resets on restart, move to a shared store if the app runs on several servers.
  const attempts = new Map();
  // Adds one to a counter and returns it. A new key in a full map counts as over every limit: clearing the map would also wipe account lockouts.
  function count(key) {
    const now = Date.now();
    let entry = attempts.get(key);
    if (!entry && attempts.size >= maxKeys) {
      for (const [k, e] of attempts) if (e.resetAt < now) attempts.delete(k);
      if (attempts.size >= maxKeys) return Infinity;
    }
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      attempts.set(key, entry);
    }
    return ++entry.count;
  }
  const refund = (key) => {
    const entry = attempts.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
  };
  // Returns null when limited, else settle(success): a success hands the failure counts back, anything else hands back the success count.
  // A refused request is not a success (its success count is handed back) and, if the address success cap refused it, not a failure either.
  // Trade-off accepted: the email bucket spans all addresses, so someone guessing a victim's password locks the victim out for the window.
  function limit(req, kind, email) {
    const ip = ipKey(req.ip ?? "");
    const failIp = `fail|${ip}`;
    const okIp = `ok|${ip}`;
    // Address buckets first, so a blocked address never creates per-account keys.
    if (count(failIp) > ipFailures) return null;
    if (count(okIp) > ipSuccesses) return refund(failIp), null;
    const acct = `acct|${kind}|${ip}|${email}`;
    const mail = `mail|${kind}|${email}`;
    if (count(acct) > accountFailures || count(mail) > emailFailures) return refund(okIp), null;
    return (success) => (success ? [failIp, acct, mail] : [okIp]).forEach(refund);
  }
  const tooManyReply = (res) => res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });

  // At most scryptConcurrency hashes at once. A finishing job hands its slot straight to the next waiter.
  // Returns undefined without running the job when the client has already hung up, so abandoned requests do not hold up the queue.
  let running = 0;
  const waiting = [];
  async function gated(req, job) {
    if (running >= scryptConcurrency) await new Promise((resolve) => waiting.push(resolve));
    else running += 1;
    try {
      return req.socket.destroyed ? undefined : await job();
    } finally {
      if (waiting.length) waiting.shift()();
      else running -= 1;
    }
  }

  // Express 4 ignores a rejected async handler, so hand it to the error middleware instead of crashing the process.
  const wrap = (handler) => (req, res, next) => handler(req, res, next).catch(next);

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // JSON only: a plain HTML form from another site cannot post here.
  router.use((req, res, next) =>
    req.method === "POST" && !req.is("application/json")
      ? res.status(415).json({ error: "JSON only." })
      : next(),
  );

  // Returns { email, password, role }, or null unless both fields are strings and the email is a CADT address (only those can have an account).
  function credentials(body) {
    if (typeof body?.email !== "string" || typeof body?.password !== "string") return null;
    const email = body.email.trim().toLowerCase();
    const role = roleFor(email);
    return role ? { email, password: body.password, role } : null;
  }

  router.post("/signup", wrap(async (req, res) => {
    const input = credentials(req.body);
    if (!input) return res.status(400).json({ error: EMAIL_HELP });
    const { email, password, role } = input;
    const weak = passwordError(password);
    if (weak) return res.status(400).json({ error: weak });
    const settle = limit(req, "signup", email);
    if (!settle) return tooManyReply(res);
    const fullName = displayName(email);
    const hash = await gated(req, () => hashPassword(password));
    if (!hash) return settle(false); // client hung up while queued, nobody to answer
    let id;
    try {
      id = Number(
        db.prepare("INSERT INTO users (email, full_name, role, password_hash) VALUES (?, ?, ?, ?)").run(email, fullName, role, hash)
          .lastInsertRowid,
      );
    } catch (err) {
      settle(false);
      // The UNIQUE constraint is the real duplicate check: two simultaneous signups both get past any earlier SELECT.
      if (err.errcode === 2067 || /UNIQUE/.test(err.message)) {
        return res.status(409).json({ error: "An account with this email already exists. Log in instead." });
      }
      throw err;
    }
    settle(true);
    startSession(db, res, id, maxSessionsPerUser);
    res.status(201).json({ user: { id, email, fullName, role } });
  }));

  router.post("/login", wrap(async (req, res) => {
    const input = credentials(req.body);
    // Anything that is not a CADT address is rejected before it can fill the limiter.
    if (!input) return res.status(400).json({ error: EMAIL_HELP });
    const { email, password } = input;
    const settle = limit(req, "login", email);
    if (!settle) return tooManyReply(res);
    const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    const ok = await gated(req, () => checkPassword(password, row?.password_hash ?? DUMMY_HASH));
    if (ok === undefined) return settle(false); // client hung up while queued, nobody to answer
    settle(Boolean(row && ok));
    if (!row || !ok) return res.status(401).json({ error: "Wrong email or password." });
    startSession(db, res, row.id, maxSessionsPerUser);
    res.json({ user: { id: row.id, email: row.email, fullName: row.full_name, role: row.role } });
  }));

  router.post("/logout", (req, res) => {
    const sid = readSid(req);
    if (sid) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(sid));
    res.clearCookie("sid", { path: "/" });
    res.status(204).end();
  });

  router.get("/me", (req, res) => {
    const user = sessionUser(db, req);
    return user ? res.json({ user }) : res.status(401).json({ error: "Not logged in." });
  });

  return router;
}
