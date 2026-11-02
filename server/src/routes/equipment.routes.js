import { Router } from 'express';

import {
  getEquipment,
  getEquipmentDetail,
  createEquipmentHandler,
  updateEquipmentHandler,
  deleteEquipmentHandler,
} from '../controllers/equipment.controller.js';

import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate,authorize} from '../middlewares/auth.middleware.js';


const router = Router();

// Public routes
router.get('/', asyncHandler(getEquipment));
router.get('/:id', asyncHandler(getEquipmentDetail));

// Admin routes
router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(createEquipmentHandler)
);

router.patch(
  '/:id',
  authenticate,
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(updateEquipmentHandler)
);

router.delete(
  '/:id',
  authenticate,
  authorize('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(deleteEquipmentHandler)
);

export default router;