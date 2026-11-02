
import { Router } from 'express';
import equipmentRoutes from './equipment.routes.js';
import authRoutes from './auth.route.js';
import { checkDatabase } from '../controllers/health.controller.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate ,authorize} from '../middlewares/auth.middleware.js';
import categoryRoutes from './category.routes.js';
import assetRoutes from './asset.routes.js';
import borrowRequestRoutes from './borrow-request.routes.js';
import borrowingRoutes from './borrow-request.routes.js';
import notificationRoutes from './notification.routes.js';
import auditLogRoutes from './audit-log.routes.js';
import { getDashboardSummaryHandler } from '../controllers/dashboard.controller.js';

const router = Router();

router.use('/borrow-requests', borrowRequestRoutes);
router.use('/borrowings', borrowingRoutes);
router.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

router.get('/health/db', asyncHandler(checkDatabase));

router.use('/equipment', equipmentRoutes);
router.use('/auth', authRoutes);
router.get('/auth/me', authenticate, (req, res) => {
  res.json({
    message: 'Authentication successful',
    user: req.user,
  });
});
router.get(
  '/admin/dashboard',
  authenticate,
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(getDashboardSummaryHandler)
);
router.use('/categories', categoryRoutes);
router.use('/assets', assetRoutes);
router.use('/borrow-requests', borrowRequestRoutes);
router.use('/borrowings', borrowingRoutes);
router.use('/notifications', notificationRoutes);
router.get(
  '/admin/dashboard',
  authenticate,
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(getDashboardSummaryHandler)
);

router.use('/audit-logs', auditLogRoutes);

export default router;
