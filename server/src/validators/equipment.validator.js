import { z } from 'zod';

// Search equipment
export const equipmentQuerySchema = z.object({
  search: z.string().trim().optional(),
});

// Create equipment
export const createEquipmentSchema = z.object({
  name: z.string().trim().min(2).max(150),
  categoryId: z.string().min(1, 'Category is required'),
  description: z.string().trim().optional(),
  brand: z.string().trim().optional(),
  model: z.string().trim().optional(),
  imageUrl: z.string().url().optional(),
});

// Update equipment
export const updateEquipmentSchema = createEquipmentSchema
  .omit({ categoryId: true })
  .partial()
  .extend({
    categoryId: z.string().min(1).optional(),
  });