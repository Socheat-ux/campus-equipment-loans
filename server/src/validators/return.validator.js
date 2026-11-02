
import { z } from 'zod';

export const returnEquipmentSchema = z.object({
  condition: z.enum([
    'NEW',
    'EXCELLENT',
    'GOOD',
    'FAIR',
    'DAMAGED',
  ]),
  notes: z.string()
    .trim()
    .max(500, 'Notes cannot exceed 500 characters')
    .optional(),
});
