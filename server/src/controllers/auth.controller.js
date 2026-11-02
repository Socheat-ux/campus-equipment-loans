
import { loginSchema, registerSchema } from '../validators/auth.validator.js';
import { loginUser, registerUser } from '../services/auth.service.js';

export async function register(req, res) {
  const validatedData = registerSchema.parse(req.body);

  const user = await registerUser(validatedData);

  res.status(201).json({
    message: 'Registration successful',
    user,
  });
}
export async function login(req, res) {
  const validatedData = loginSchema.parse(req.body);
  const result = await loginUser(validatedData);

  res.status(200).json({
    message: 'Login successful',
    ...result,
  });
}
