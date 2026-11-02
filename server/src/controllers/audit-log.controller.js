
import {
  getAllAuditLogs,
  getEntityAuditLogs,
} from '../services/audit-log.service.js';

// Get all audit logs
export async function getAllAuditLogsHandler(req, res) {
  const logs = await getAllAuditLogs();

  res.json({
    message: 'Audit logs retrieved successfully',
    data: logs,
  });
}

// Get logs for a specific entity
export async function getEntityAuditLogsHandler(req, res) {
  const { entityType, entityId } = req.params;

  const logs = await getEntityAuditLogs(entityType, entityId);

  res.json({
    message: 'Entity audit logs retrieved successfully',
    data: logs,
  });
}
