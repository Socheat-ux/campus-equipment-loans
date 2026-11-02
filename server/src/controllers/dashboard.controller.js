
import { getDashboardSummary } from '../services/dashboard.service.js';

export async function getDashboardSummaryHandler(req, res) {
  const summary = await getDashboardSummary();

  res.json({
    message: 'Dashboard summary retrieved successfully',
    data: summary,
  });
}
