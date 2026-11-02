
import { prisma } from '../config/database.js';

// Create an audit log
export function createAuditLog({
  userId,
  action,
  entityType,
  entityId,
  details,
}) {
  return prisma.auditLog.create({
    data: {
      userId,
      action,
      entityType,
      entityId,
      details,
    },
  });
}

// Get all audit logs (Admin)
export function getAllAuditLogs() {
  return prisma.auditLog.findMany({
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}
export async function getAllAuditLogsHandler(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
  const search = req.query.search?.trim();

  const { logs, total } = await getAllAuditLogs({
    page,
    limit,
    search,
  });

  res.json({
    message: 'Audit logs retrieved successfully',
    data: logs,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}


// Get audit logs for a specific entity
export function getEntityAuditLogs(entityType, entityId) {
  return prisma.auditLog.findMany({
    where: {
      entityType,
      entityId,
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}
