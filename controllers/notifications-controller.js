import mongoose from "mongoose";
import Notification from "../models/notification.js";
import HttpError from "../models/http-error.js";
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

    const recipientId = mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : userId;

    // 🔥 FIXED QUERY
    const unreadMatch = {
      recipient: recipientId,
      $or: [
        { isRead: false },
        { isRead: { $exists: false } },
        { isRead: null },
      ],
    };

    const notifications = await trackDatabaseOperation(
      "find",
      "notifications",
      () =>
        Notification.find(unreadMatch)
          .sort({ createdAt: -1 })
          .populate("sender", "name image")
          .lean({ virtuals: true }),
    );

    const unreadCount = await trackDatabaseOperation(
      "countDocuments",
      "notifications",
      () => Notification.countDocuments(unreadMatch),
    );

    requestLogger.debug("Fetched notifications", {
      userId,
      unreadCount,
    });

    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
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
      requestLogger.warn(
        "Notification could not be marked as read because it was not found",
        {
          notificationId: nid,
          userId: req.userData.userId,
        },
      );
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
