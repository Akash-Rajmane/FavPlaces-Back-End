import PushSubscription from "../models/pushSubscription.js";
import HttpError from "../models/http-error.js";
import logger from "../util/logger.js";
import {
  recordBusinessEvent,
  trackDatabaseOperation,
} from "../middleware/metrics.js";

const pushControllerLogger = logger.child({ component: "push-controller" });

const getRequestLogger = (req) =>
  req.logger?.child({ component: "push-controller" }) || pushControllerLogger;

export const subscribe = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const { subscription } = req.body;

  if (!subscription) {
    recordBusinessEvent("push_subscribe", "missing_subscription");
    requestLogger.warn("Push subscription payload is missing", {
      userId: req.userData.userId,
    });
    return next(new HttpError("Subscription data missing", 422));
  }

  try {
    await trackDatabaseOperation("upsert", "pushSubscriptions", () =>
      PushSubscription.findOneAndUpdate(
        { user: req.userData.userId },
        { subscription },
        { upsert: true, new: true },
      ),
    );

    recordBusinessEvent("push_subscribe", "success");
    requestLogger.info("Push subscription saved", {
      userId: req.userData.userId,
    });

    res.status(201).json({ message: "Push subscription saved" });
  } catch (error) {
    recordBusinessEvent("push_subscribe", "database_error");
    requestLogger.error("Saving push subscription failed", {
      error,
      userId: req.userData.userId,
    });
    return next(new HttpError("Saving push subscription failed", 500));
  }
};

export const unsubscribe = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);

  try {
    await trackDatabaseOperation("delete", "pushSubscriptions", () =>
      PushSubscription.findOneAndDelete({
        user: req.userData.userId,
      }),
    );

    recordBusinessEvent("push_unsubscribe", "success");
    requestLogger.info("Push subscription removed", {
      userId: req.userData.userId,
    });

    res.json({ message: "Push subscription removed" });
  } catch (error) {
    recordBusinessEvent("push_unsubscribe", "database_error");
    requestLogger.error("Removing push subscription failed", {
      error,
      userId: req.userData.userId,
    });
    return next(new HttpError("Removing push subscription failed", 500));
  }
};
