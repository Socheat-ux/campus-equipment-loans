import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';



export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      message: 'Authentication token is required',
    });
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      message: 'Authentication token is missing',
    });
  }

  try {
    const decoded = jwt.verify(token, env.jwtSecret);

    req.user = {
      id: decoded.userId,
      role: decoded.role,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      message:
        error.name === 'TokenExpiredError'
          ? 'Authentication token has expired'
          : 'Invalid authentication token',
    });
  }
}


export function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required',
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'You do not have permission to access this resource',
      });
    }

    next();
  };
}