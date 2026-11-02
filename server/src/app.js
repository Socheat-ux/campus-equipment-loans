import cors from 'cors';
import express from 'express';
import { env } from './config/env.js';
import apiRoutes from './routes/index.js';
import { errorHandler } from './middlewares/errorHandler.js';

const app = express();
app.use(cors({ origin: env.clientOrigin }));
app.use(express.json());
app.use('/api', apiRoutes);
app.use(errorHandler);

export default app;

