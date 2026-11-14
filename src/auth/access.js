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

const LABELS = { student: "students", faculty: "faculty", admin: "administrators" };

// "administrators", "students and faculty", ...: used in the "not allowed" message.
export function rolesLabel(roles) {
  const names = roles.map((role) => LABELS[role]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}
