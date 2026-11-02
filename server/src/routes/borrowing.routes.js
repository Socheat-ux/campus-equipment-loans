
import { Router } from 'express';

import {
  issueBorrowingHandler,
  returnBorrowingHandler,
  getAllBorrowingsHandler,
  getMyBorrowingsHandler,
} from '../controllers/borrowing.controller.js';

import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { authorize } from '../middlewares/authorize.middleware.js';

const router = Router();

router.use(authenticate);

// Personal borrowing history
router.get(
  '/my',
  authorize('STUDENT', 'STAFF'),
  asyncHandler(getMyBorrowingsHandler)
);

// Admin borrowing records
router.get(
  '/',
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(getAllBorrowingsHandler)
);

// Issue approved equipment
router.post(
  '/:requestId/issue',
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(issueBorrowingHandler)
);

// Return equipment
router.patch(
  '/:borrowingId/return',
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(returnBorrowingHandler)
);

export default router;
