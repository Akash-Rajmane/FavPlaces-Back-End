import mongoose from "mongoose";
import Follow from "../models/follow.js";
import Notification from "../models/notification.js";
import PushSubscription from "../models/pushSubscription.js";
import sendPush from "../util/push.js";
import HttpError from "../models/http-error.js";
import cacheKeys from "../util/cache-keys.js";
import { deleteKeys, getJson, setJson } from "../util/cache.js";
import logger from "../util/logger.js";
import {
  recordBusinessEvent,
  trackDatabaseOperation,
} from "../middleware/metrics.js";

const followLogger = logger.child({ component: "follow-controller" });

const getRequestLogger = (req) =>
  req.logger?.child({ component: "follow-controller" }) || followLogger;

const invalidateFollowCaches = async (requestRecipientId) => {
  await deleteKeys(
    cacheKeys.followRequests(requestRecipientId),
    cacheKeys.publicUsers(),
  );
};

export const requestFollow = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const { userId } = req.body;
  const followerId = req.userData.userId;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    recordBusinessEvent("follow_request", "invalid_user");
    requestLogger.warn("Follow request failed because the target user id is invalid", {
      followerId,
      followingId: userId,
    });
    return next(new HttpError("Invalid user id", 400));
  }

  if (userId === followerId) {
    recordBusinessEvent("follow_request", "self_follow");
    requestLogger.warn("Follow request blocked because users cannot follow themselves", {
      followerId,
    });
    return next(new HttpError("You cannot follow yourself", 400));
  }

  try {
    const follow = await trackDatabaseOperation("insert", "follows", () =>
      Follow.create({
        follower: followerId,
        following: userId,
      }),
    );

    await trackDatabaseOperation("insert", "notifications", () =>
      Notification.create({
        recipient: userId,
        sender: followerId,
        type: "FOLLOW_REQUEST",
        message: "You received a follow request",
        link: "/profile",
      }),
    );

    const sub = await trackDatabaseOperation("findOne", "pushSubscriptions", () =>
      PushSubscription.findOne({ user: userId }),
    );

    if (sub) {
      void sendPush(sub.subscription, {
        title: "New Follow Request",
        body: "Someone wants to follow you",
        url: "/followers",
      });
    }

    recordBusinessEvent("follow_request", "success");
    await invalidateFollowCaches(userId);
    requestLogger.info("Follow request sent", {
      followId: follow._id.toString(),
      followerId,
      followingId: userId,
      pushQueued: Boolean(sub),
    });

    res.status(201).json({ message: "Follow request sent" });
  } catch (error) {
    if (error.code === 11000) {
      recordBusinessEvent("follow_request", "duplicate");
      requestLogger.warn("Duplicate follow request prevented", {
        followerId,
        followingId: userId,
      });
      return next(new HttpError("Follow request already exists", 409));
    }

    recordBusinessEvent("follow_request", "database_error");
    requestLogger.error("Sending follow request failed", {
      error,
      followerId,
      followingId: userId,
    });
    return next(new HttpError("Sending follow request failed", 500));
  }
};

export const getFollowRequests = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);

  try {
    const cacheKey = cacheKeys.followRequests(req.userData.userId);
    const cachedRequests = await getJson(cacheKey);
    if (cachedRequests) {
      requestLogger.debug("Fetched follow requests from cache", {
        userId: req.userData.userId,
      });
      return res.json({ requests: cachedRequests });
    }

    const requests = await trackDatabaseOperation("find", "follows", () =>
      Follow.find({
        following: req.userData.userId,
        status: "pending",
      })
        .populate("follower", "name image")
        .lean(),
    );

    await setJson(cacheKey, requests, 30);

    res.json({ requests });
  } catch (error) {
    requestLogger.error("Fetching follow requests failed", {
      error,
      userId: req.userData.userId,
    });
    return next(new HttpError("Fetching follow requests failed", 500));
  }
};

export const acceptFollow = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const { followId } = req.body;

  try {
    const follow = await trackDatabaseOperation("findById", "follows", () =>
      Follow.findById(followId),
    );

    if (!follow) {
      recordBusinessEvent("follow_accept", "not_found");
      requestLogger.warn("Accept follow failed because the follow request was not found", {
        followId,
        userId: req.userData.userId,
      });
      return next(new HttpError("Follow request not found", 404));
    }

    if (follow.following.toString() !== req.userData.userId) {
      recordBusinessEvent("follow_accept", "unauthorized");
      requestLogger.warn("Accept follow failed because the user is not authorized", {
        followId,
        userId: req.userData.userId,
      });
      return next(new HttpError("Not authorized", 401));
    }

    follow.status = "accepted";
    await trackDatabaseOperation("save", "follows", () => follow.save());

    await trackDatabaseOperation("insert", "notifications", () =>
      Notification.create({
        recipient: follow.follower,
        sender: req.userData.userId,
        type: "FOLLOW_ACCEPTED",
        message: "Your follow request was accepted",
        link: `/${req.userData.userId}/places`,
      }),
    );

    const sub = await trackDatabaseOperation("findOne", "pushSubscriptions", () =>
      PushSubscription.findOne({ user: follow.follower }),
    );

    if (sub) {
      void sendPush(sub.subscription, {
        title: "Follow request accepted",
        body: "You can now see this user's places",
        url: `/${req.userData.userId}/places`,
      });
    }

    recordBusinessEvent("follow_accept", "success");
    await invalidateFollowCaches(req.userData.userId);
    requestLogger.info("Follow request accepted", {
      followId,
      userId: req.userData.userId,
      followerId: follow.follower.toString(),
    });

    res.json({ message: "Follow request accepted" });
  } catch (error) {
    recordBusinessEvent("follow_accept", "database_error");
    requestLogger.error("Accepting follow request failed", {
      error,
      followId,
      userId: req.userData.userId,
    });
    return next(new HttpError("Accepting follow request failed", 500));
  }
};

export const rejectFollow = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const { followId } = req.body;

  try {
    const follow = await trackDatabaseOperation("findById", "follows", () =>
      Follow.findById(followId),
    );

    if (!follow) {
      recordBusinessEvent("follow_reject", "not_found");
      requestLogger.warn("Reject follow failed because the follow request was not found", {
        followId,
        userId: req.userData.userId,
      });
      return next(new HttpError("Follow request not found", 404));
    }

    if (follow.following.toString() !== req.userData.userId) {
      recordBusinessEvent("follow_reject", "unauthorized");
      requestLogger.warn("Reject follow failed because the user is not authorized", {
        followId,
        userId: req.userData.userId,
      });
      return next(new HttpError("Not authorized", 401));
    }

    await trackDatabaseOperation("delete", "follows", () =>
      Follow.findByIdAndDelete(followId),
    );

    recordBusinessEvent("follow_reject", "success");
    await invalidateFollowCaches(req.userData.userId);
    requestLogger.info("Follow request rejected", {
      followId,
      userId: req.userData.userId,
      followerId: follow.follower.toString(),
    });

    res.json({ message: "Follow request rejected" });
  } catch (error) {
    recordBusinessEvent("follow_reject", "database_error");
    requestLogger.error("Rejecting follow request failed", {
      error,
      followId,
      userId: req.userData.userId,
    });
    return next(new HttpError("Rejecting follow request failed", 500));
  }
};
