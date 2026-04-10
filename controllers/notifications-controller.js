import Notification from "../models/notification.js";
import HttpError from "../models/http-error.js";
import cacheKeys from "../util/cache-keys.js";
import { deleteKeys, remember } from "../util/cache.js";
import logger from "../util/logger.js";
import {
  recordBusinessEvent,
  trackDatabaseOperation,
} from "../middleware/metrics.js";

const notificationsLogger = logger.child({
  component: "notifications-controller",
});

const getRequestLogger = (req) =>
  req.logger?.child({ component: "notifications-controller" }) ||
  notificationsLogger;

export const getNotifications = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);

  try {
    const userId = req.userData.userId;
    const { value: notifications, cacheHit } = await remember(
      cacheKeys.notificationsList(userId),
      30,
      () =>
        trackDatabaseOperation("find", "notifications", () =>
          Notification.find({
            recipient: userId,
          })
            .sort({ createdAt: -1 })
            .populate("sender", "name image")
            .lean({ virtuals: true }),
        ),
    );

    const { value: unreadCount } = await remember(
      cacheKeys.notificationsUnreadCount(userId),
      30,
      () =>
        trackDatabaseOperation("countDocuments", "notifications", () =>
          Notification.countDocuments({
            recipient: userId,
            isRead: false,
          }),
        ),
    );

    requestLogger.debug("Fetched notifications", {
      userId,
      cacheHit,
      unreadCount,
    });

    res.json({ notifications, unreadCount });
  } catch (error) {
    requestLogger.error("Fetching notifications failed", {
      error,
      userId: req.userData.userId,
    });
    return next(new HttpError("Fetching notifications failed", 500));
  }
};

export const markAsRead = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const nid = req.params.nid;

  try {
    const notification = await trackDatabaseOperation(
      "findById",
      "notifications",
      () => Notification.findById(nid),
    );

    if (!notification) {
      recordBusinessEvent("notification_mark_read", "not_found");
      requestLogger.warn("Notification could not be marked as read because it was not found", {
        notificationId: nid,
        userId: req.userData.userId,
      });
      return next(new HttpError("Notification not found", 404));
    }

    if (notification.recipient.toString() !== req.userData.userId) {
      recordBusinessEvent("notification_mark_read", "unauthorized");
      requestLogger.warn("Notification mark-as-read was not authorized", {
        notificationId: nid,
        userId: req.userData.userId,
      });
      return next(new HttpError("Not authorized", 401));
    }

    notification.isRead = true;
    await trackDatabaseOperation("save", "notifications", () =>
      notification.save(),
    );

    recordBusinessEvent("notification_mark_read", "success");
    await deleteKeys(
      cacheKeys.notificationsList(req.userData.userId),
      cacheKeys.notificationsUnreadCount(req.userData.userId),
    );
    requestLogger.info("Notification marked as read", {
      notificationId: nid,
      userId: req.userData.userId,
    });

    res.json({ message: "Marked as read" });
  } catch (error) {
    recordBusinessEvent("notification_mark_read", "database_error");
    requestLogger.error("Updating notification failed", {
      error,
      notificationId: nid,
      userId: req.userData.userId,
    });
    return next(new HttpError("Updating notification failed", 500));
  }
};
