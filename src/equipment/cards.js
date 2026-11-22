import { BORROW_MAX_DAYS } from "../../server/rules.js";

export const CATEGORY_IMAGES = {
  Laptop: "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800",
  Camera: "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=800",
  Projector: "https://images.unsplash.com/photo-1535016120720-40c646be5580?w=800",
  Audio: "https://images.unsplash.com/photo-1590602847861-f357a9332bbc?w=800",
  Networking: "https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=800",
  Lab: "https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?w=800",
  Accessories: "https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?w=800",
  Other: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800",
};

// The catalogue only stores name, category and stock counts, so the card details
// that the design calls for are derived here.
export function asCard(item) {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    image: CATEGORY_IMAGES[item.category] ?? CATEGORY_IMAGES.Other,
    description: `${item.category} equipment available for student borrowing.`,
    assetId: `EQ-${String(item.id).padStart(4, "0")}`,
    location: "Library Tech Hub",
    available: item.available > 0,
    stock: item.available,
    maxDays: BORROW_MAX_DAYS,
  };
}

export function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(`${iso}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
