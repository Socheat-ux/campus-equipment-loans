import { z } from 'zod';

// Create a physical asset
export const createAssetSchema = z.object({
  equipmentId: z.string().min(1, 'Equipment is required'),
  assetCode: z.string().trim().min(2).max(50),
  serialNumber: z.string().trim().optional(),
  condition: z.enum([
    'NEW',
    'EXCELLENT',
    'GOOD',
    'FAIR',
    'DAMAGED',
  ]).default('GOOD'),
});

// Update an asset
export const updateAssetSchema = z.object({
  assetCode: z.string().trim().min(2).max(50).optional(),
  serialNumber: z.string().trim().optional(),
  condition: z.enum([
    'NEW',
    'EXCELLENT',
    'GOOD',
    'FAIR',
    'DAMAGED',
  ]).optional(),
  status: z.enum([
    'AVAILABLE',
    'RESERVED',
    'BORROWED',
    'MAINTENANCE',
    'RETIRED',
    'LOST',
  ]).optional(),
});