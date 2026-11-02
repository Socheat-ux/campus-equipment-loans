import { z } from 'zod';

export const createBorrowRequestSchema = z.object({
  assetId: z.string().min(1, 'Asset is required'),

  requestedStart: z.coerce.date(),

  requestedEnd: z.coerce.date(),

  purpose: z.string()
    .trim()
    .min(5, 'Purpose must be at least 5 characters')
    .max(500),
}).refine(
  (data) => data.requestedEnd > data.requestedStart,
  {
    message: 'End date must be after start date',
    path: ['requestedEnd'],
  }
);

export const reviewBorrowRequestSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),

  rejectionReason: z.string()
    .trim()
    .max(500)
    .optional(),
}).refine(
  (data) =>
    data.status !== 'REJECTED' ||
    Boolean(data.rejectionReason?.trim()),
  {
    message: 'Rejection reason is required',
    path: ['rejectionReason'],
  }
);