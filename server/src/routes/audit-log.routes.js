
import { Router } from 'express';

import {
  getAllAuditLogsHandler,
  getEntityAuditLogsHandler,
} from '../controllers/audit-log.controller.js';

import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate ,authorize} from '../middlewares/auth.middleware.js';


const router = Router();

router.use(authenticate);
router.use(authorize('ADMIN', 'SUPER_ADMIN'));

// Get all audit logs
router.get('/', asyncHandler(getAllAuditLogsHandler));

// Get logs for a specific entity
router.get(
  '/:entityType/:entityId',
  asyncHandler(getEntityAuditLogsHandler)
);

export default router;
