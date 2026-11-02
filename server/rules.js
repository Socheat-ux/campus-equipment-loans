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
