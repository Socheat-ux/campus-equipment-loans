
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

export function errorHandler(error, _req, res, _next) {
  console.error(error);

  // Validation errors
  if (error instanceof ZodError) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  // Duplicate database records
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return res.status(409).json({
        message: 'A record with this value already exists',
      });
    }

    // Record not found
    if (error.code === 'P2025') {
      return res.status(404).json({
        message: 'Record not found',
      });
    }
  }

  // Other application errors
  const status = error.status || 500;

  return res.status(status).json({
    message:
      status === 500
        ? 'Internal server error'
        : error.message,
  });
}
