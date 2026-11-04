// Pure rules, no Node imports: the server and the browser both import this file.
const NAME = "[a-z]+(?:['-][a-z]+)*";
const STUDENT = new RegExp(`^${NAME}\\.${NAME}\\d{0,3}@student\\.cadt\\.edu\\.kh$`, "i");
const FACULTY = new RegExp(`^${NAME}(?:\\.${NAME})+\\d{0,3}@cadt\\.edu\\.kh$`, "i");

export const EMAIL_HELP =
  "Use your CADT email: LastName.FirstName@student.cadt.edu.kh for students, or @cadt.edu.kh for faculty.";

export function roleFor(email) {
  if (email.length > 254) return null;
  if (STUDENT.test(email)) return "student";
  if (FACULTY.test(email)) return "faculty";
  return null;
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
