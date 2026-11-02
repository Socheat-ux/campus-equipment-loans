// Pure rules, no Node imports: the server and the browser both import this file.
const NAME = "[a-z]+(?:['-][a-z]+)*";
const STUDENT = new RegExp(`^${NAME}\\.${NAME}\\d{0,3}@student\\.cadt\\.edu\\.kh$`, "i");
const FACULTY = new RegExp(`^${NAME}(?:\\.${NAME})+\\d{0,3}@cadt\\.edu\\.kh$`, "i");

export const EMAIL_HELP =
  "Enter a valid email address. Non-CADT addresses are registered as Student accounts.";

export function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/i.test(email);
}

export function roleFor(email) {
  if (!isValidEmail(email)) return null;
  if (STUDENT.test(email)) return "student";
  if (FACULTY.test(email)) return "faculty";
  // Personal or non-CADT institutional addresses can still create student accounts.
  return "student";
}

// Keeps the email's order (family name first, Southeast Asian style). Never swapped to "First Last".
export function displayName(email) {
  return email
    .split("@")[0]
    .replace(/\d+$/, "")
    .split(".")
    .map((part) => part.replace(/(^|['-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase()))
    .join(" ");
}

export function passwordError(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Password must be at least 8 characters.";
  if (pw.length > 128) return "Password must be 128 characters or fewer.";
  if (!/\p{L}/u.test(pw) || !/\d/.test(pw)) return "Password needs at least one letter and one number.";
  return null;
}
