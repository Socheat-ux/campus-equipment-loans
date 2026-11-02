
import { prisma } from '../config/database.js';


export async function getDashboardSummary() {
  const [
    totalUsers,
    totalEquipment,
    totalAssets,
    availableAssets,
    borrowedAssets,
    pendingRequests,
    activeBorrowings,
    overdueBorrowings,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.equipment.count(),
    prisma.asset.count(),
    prisma.asset.count({ where: { status: 'AVAILABLE' } }),
    prisma.asset.count({ where: { status: 'BORROWED' } }),
    prisma.borrowRequest.count({ where: { status: 'PENDING' } }),
    prisma.borrowing.count({ where: { status: 'ACTIVE' } }),
    prisma.borrowing.count({ where: { status: 'OVERDUE' } }),
  ]);

  return {
    totalUsers,
    totalEquipment,
    totalAssets,
    availableAssets,
    borrowedAssets,
    pendingRequests,
    activeBorrowings,
    overdueBorrowings,
  };
}
