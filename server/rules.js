// Pure rules, no Node imports: the server and the browser both import this file.
const NAME = "[a-z]+(?:['-][a-z]+)*";
const STUDENT = new RegExp(`^${NAME}\\.${NAME}\\d{0,3}@student\\.cadt\\.edu\\.kh$`, "i");
const FACULTY = new RegExp(`^${NAME}(?:\\.${NAME})+\\d{0,3}@cadt\\.edu\\.kh$`, "i");

// Every role an account can have. The users table CHECK constraint lists the same three.
export const ROLES = ["student", "faculty", "admin"];

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

export const EQUIPMENT_CATEGORIES = [
  "Laptop",
  "Projector",
  "Camera",
  "Audio",
  "Networking",
  "Lab",
  "Accessories",
  "Other",
];

export const EQUIPMENT_NAME_MAX = 100;

export function equipmentNameError(name) {
  if (typeof name !== "string" || !name.trim()) return "Enter the equipment name.";
  if (name.trim().length > EQUIPMENT_NAME_MAX) return `Equipment name must be ${EQUIPMENT_NAME_MAX} characters or fewer.`;
  return null;
}

export function equipmentCategoryError(category) {
  return EQUIPMENT_CATEGORIES.includes(category) ? null : "Choose a category.";
}

export function equipmentQuantityError(quantity) {
  if (quantity === "" || quantity === null || quantity === undefined) return "Enter a quantity.";
  if (typeof quantity !== "number" && typeof quantity !== "string") return "Quantity must be a whole number.";
  const value = Number(quantity);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return "Quantity must be a whole number.";
  if (value < 0) return "Quantity must be 0 or more.";
  if (value > 100000) return "Quantity must be 100,000 or fewer.";
  return null;
}

export const BORROW_MAX_DAYS = 7;
export const PURPOSE_MAX = 500;
export const REJECTION_REASON_MAX = 500;

// Dates are plain calendar days ("YYYY-MM-DD"), so they compare and add without a time zone getting involved.
export function parseISODate(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
}

export function todayISO(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDaysISO(iso, days) {
  const date = parseISODate(iso);
  if (!date || !Number.isInteger(days)) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function borrowDateError(value, today = todayISO()) {
  if (typeof value !== "string" || !value.trim()) return "Choose a borrow date.";
  const date = parseISODate(value.trim());
  if (!date) return "Enter a valid date.";
  if (value.trim() < today) return "Borrow date cannot be in the past.";
  return null;
}

export function purposeError(purpose) {
  if (purpose === null || purpose === undefined || purpose === "") return null;
  if (typeof purpose !== "string") return "Purpose must be text.";
  if (purpose.trim().length > PURPOSE_MAX) return `Purpose must be ${PURPOSE_MAX} characters or fewer.`;
  return null;
}

export function rejectionReasonError(reason) {
  if (typeof reason !== "string" || !reason.trim()) return "A reason is required.";
  if (reason.trim().length > REJECTION_REASON_MAX) return `Reason must be ${REJECTION_REASON_MAX} characters or fewer.`;
  return null;
}

// Shared by the request form and the server. The return date is calculated here; a client-sent one is ignored.
export function borrowRequestInput(body, today = todayISO()) {
  const rawId = body?.equipmentId;
  const equipmentId =
    typeof rawId === "number" || (typeof rawId === "string" && rawId.trim() !== "") ? Number(rawId) : NaN;
  const borrowDate = typeof body?.borrowDate === "string" ? body.borrowDate.trim() : "";
  const purpose = typeof body?.purpose === "string" ? body.purpose.trim() : "";

  const fields = {};
  if (!Number.isInteger(equipmentId) || equipmentId < 1) fields.equipmentId = "Choose an item to borrow.";
  const dateError = borrowDateError(borrowDate, today);
  if (dateError) fields.borrowDate = dateError;
  const textError = purposeError(purpose);
  if (textError) fields.purpose = textError;

  return {
    fields,
    value: {
      equipmentId: Number.isInteger(equipmentId) ? equipmentId : null,
      borrowDate,
      returnDate: dateError ? null : addDaysISO(borrowDate, BORROW_MAX_DAYS),
      purpose: purpose || null,
    },
  };
}

// Shared by the form and the server: returns normalised values plus a message per bad field.
export function equipmentInput(body) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const category = typeof body?.category === "string" ? body.category : "";
  const quantity = body?.quantity === null || body?.quantity === undefined ? "" : body.quantity;

  const fields = {};
  const nameError = equipmentNameError(name);
  const categoryError = equipmentCategoryError(category);
  const quantityError = equipmentQuantityError(quantity);
  if (nameError) fields.name = nameError;
  if (categoryError) fields.category = categoryError;
  if (quantityError) fields.quantity = quantityError;

  return {
    fields,
    value: { name, category, quantity: Number.isInteger(Number(quantity)) ? Number(quantity) : null },
  };
}
