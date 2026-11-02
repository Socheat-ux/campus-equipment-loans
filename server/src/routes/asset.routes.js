import { Router } from 'express';
import { getAssetQRCode } from '../controllers/asset.controller.js';
import {
  getAssets,
  getAsset,
  createAssetHandler,
  updateAssetHandler,
  deleteAssetHandler,
  
  scanAsset,
} from '../controllers/asset.controller.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate ,authorize } from '../middlewares/auth.middleware.js';
import { generateAssetQRCode } from '../services/qr.service.js';
const router = Router();

// Admin and Super Admin
router.use(authenticate, authorize('ADMIN', 'SUPER_ADMIN'));

router.get('/', asyncHandler(getAssets));
router.get('/:id', asyncHandler(getAsset));
router.post('/', asyncHandler(createAssetHandler));
router.patch('/:id', asyncHandler(updateAssetHandler));
router.delete('/:id', asyncHandler(deleteAssetHandler));

router.get('/:id/qr', asyncHandler(getAssetQRCode));

router.get('/scan/:qrToken', asyncHandler(scanAsset));
export default router;