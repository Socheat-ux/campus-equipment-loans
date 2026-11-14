import { ROLES } from "../../server/rules.js";

// What a page guard should do for this user: "login" (not signed in), "denied" (signed in, wrong role) or "ok".
// Plain logic with no React, so the server tests can check it too.
export function access(user, roles) {
  if (!Array.isArray(roles) || !roles.length || roles.some((role) => !ROLES.includes(role))) {
    throw new TypeError(`access() needs a list of one or more of: ${ROLES.join(", ")}.`);
  }
  if (!user) return "login";
  return roles.includes(user.role) ? "ok" : "denied";
}

// Where to go after login: the remembered page if it is a path inside this app, otherwise "/".
// Rejects "//host" and any backslash or control character: browsers read "/\host" and "/<tab>/host" as "//host".
export function safeReturnPath(value) {
  const inApp = typeof value === "string" && /^\/(?![\\/])/.test(value) && !/[\\\u0000-\u001f\u007f]/.test(value);
  return inApp ? value : "/";
}

const NAMES = { student: "Student", faculty: "Faculty", admin: "Administrator" };

// One role in plain words, for showing a person's own role.
export const roleName = (role) => NAMES[role] ?? role;

const LABELS = { student: "students", faculty: "faculty", admin: "administrators" };

// "administrators", "students and faculty", ...: used in the "not allowed" message.
export function rolesLabel(roles) {
  const names = roles.map((role) => LABELS[role]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}
