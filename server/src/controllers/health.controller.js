
import { prisma } from '../config/database.js';

export async function checkDatabase(_req, res) {
  await prisma.$queryRaw`SELECT 1`;

  res.json({
    status: 'ok',
    database: 'connected',
    message: 'PostgreSQL connection successful',
  });
}
