import { Router } from 'express';
import {
  register,
  login,
} from '../controllers/auth.controller.js';

import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

router.post('/register', asyncHandler(register));
router.post('/login', asyncHandler(login));

export default router;