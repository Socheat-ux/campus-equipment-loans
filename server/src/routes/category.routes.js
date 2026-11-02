import { Router } from 'express';

import {
  getCategories,
  getCategory,
 createCategoryHandler,
  updateCategoryHandler,
  deleteCategoryHandler,
} from '../controllers/category.controller.js';

import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate, authorize  } from '../middlewares/auth.middleware.js';


const router = Router();

// Publicly accessible
router.get('/', asyncHandler(getCategories));
router.get('/:id', asyncHandler(getCategory));

// Admin access only
router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(createCategoryHandler)
);

router.patch(
  '/:id',
  authenticate,
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(updateCategoryHandler)
);

router.delete(
  '/:id',
  authenticate,
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(deleteCategoryHandler)
);

export default router;