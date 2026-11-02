import { Router } from 'express';

import {
  createBorrowRequestHandler,
  getMyBorrowRequestsHandler,
  getAllBorrowRequestsHandler,
  reviewBorrowRequestHandler,
} from '../controllers/borrow-request.controller.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate ,authorize } from '../middlewares/auth.middleware.js';
import { issueBorrowingHandler,returnBorrowingHandler, } from '../controllers/borrow-request.controller.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Student and staff
router.post(
  '/',
  authorize('STUDENT', 'STAFF'),
  asyncHandler(createBorrowRequestHandler )
);

router.get(
  '/my',
  authorize('STUDENT', 'STAFF'),
  asyncHandler(getMyBorrowRequestsHandler)
);
router.post(
  '/:requestId/issue',
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(issueBorrowingHandler)
);

// Admin
router.get(
  '/',
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(getAllBorrowRequestsHandler)
);
router.patch(
  '/:id/review',
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(reviewBorrowRequestHandler)
);

router.patch(
  '/:borrowingId/return',
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(returnBorrowingHandler)
);
export default router;