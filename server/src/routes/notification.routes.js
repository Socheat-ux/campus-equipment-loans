
import { Router } from 'express';

import {
  getMyNotificationsHandler,
  markNotificationAsReadHandler,
  markAllNotificationsAsReadHandler,
} from '../controllers/notification.controller.js';

import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(authenticate);

// Get my notifications
router.get(
  '/',
  asyncHandler(getMyNotificationsHandler)
);

// Mark all notifications as read
router.patch(
  '/read-all',
  asyncHandler(markAllNotificationsAsReadHandler)
);

// Mark one notification as read
router.patch(
  '/:id/read',
  asyncHandler(markNotificationAsReadHandler)
);

export default router;
