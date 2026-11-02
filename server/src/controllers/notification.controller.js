
import {
  getMyNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
} from '../services/notification.service.js';

// Get my notifications
export async function getMyNotificationsHandler(req, res) {
  const notifications = await getMyNotifications(req.user.id);

  res.json(notifications);
}

// Mark one notification as read
export async function markNotificationAsReadHandler(req, res) {
  const notification = await markNotificationAsRead(
    req.params.id,
    req.user.id
  );

  res.json({
    message: 'Notification marked as read',
    notification,
  });
}

// Mark all notifications as read
export async function markAllNotificationsAsReadHandler(req, res) {
  const result = await markAllNotificationsAsRead(req.user.id);

  res.json({
    message: 'All notifications marked as read',
    updatedCount: result.count,
  });
}
