
import { prisma } from '../config/database.js';

// 1. Get notifications belonging to one user
export function getMyNotifications(userId) {
  return prisma.notification.findMany({
    where: {
      userId,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

// 2. Mark one notification as read
export async function markNotificationAsRead(notificationId, userId) {
  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      userId,
    },
  });

  if (!notification) {
    const error = new Error('Notification not found');
    error.status = 404;
    throw error;
  }

  return prisma.notification.update({
    where: {
      id: notificationId,
    },
    data: {
      isRead: true,
    },
  });
}

// 3. Mark all notifications as read
export function markAllNotificationsAsRead(userId) {
  return prisma.notification.updateMany({
    where: {
      userId,
      isRead: false,
    },
    data: {
      isRead: true,
    },
  });
}
