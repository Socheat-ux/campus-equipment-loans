import app from './app.js';
import { env } from './config/env.js';
import { startOverdueJob } from './jobs/overdue.job.js';

app.listen(env.port, () => {
  console.log(`Smart Borrowing API listening on port ${env.port}`);

  // Start scheduled overdue detection
  startOverdueJob();
});