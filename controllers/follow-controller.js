const mongoose = require("mongoose");

const Follow = require("../models/follow");
const User = require("../models/user");
const Notification = require("../models/notification");
const PushSubscription = require("../models/pushSubscription");
const sendPush = require("../util/push");
const HttpError = require("../models/http-error");

// -------------------- SEND FOLLOW REQUEST --------------------
exports.requestFollow = async (req, res, next) => {
  const { userId } = req.body;
  const followerId = req.userData.userId;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return next(new HttpError("Invalid user id", 400));
  }

  if (userId === followerId) {
    return next(new HttpError("You cannot follow yourself", 400));
  }

  try {
    const follow = await Follow.create({
      follower: followerId,
      following: userId,
    });

    // In-app notification
    await Notification.create({
      recipient: userId,
      sender: followerId,
      type: "FOLLOW_REQUEST",
      message: "You received a follow request 👋",
      link: "/followers",
    });

    // Push notification
    const sub = await PushSubscription.findOne({ user: userId });
    if (sub) {
      sendPush(sub.subscription, {
        title: "New Follow Request 👋",
        body: "Someone wants to follow you",
        url: "/followers",
      });
    }

    res.status(201).json({ message: "Follow request sent" });
  } catch (err) {
    if (err.code === 11000) {
      return next(new HttpError("Follow request already exists", 409));
    }
    return next(new HttpError("Sending follow request failed", 500));
  }
};

// -------------------- GET FOLLOW REQUESTS --------------------
exports.getFollowRequests = async (req, res, next) => {
  try {
    const requests = await Follow.find({
      following: req.userData.userId,
      status: "pending",
    }).populate("follower", "name image");

    res.json({ requests });
  } catch (err) {
    return next(new HttpError("Fetching follow requests failed", 500));
  }
};

// -------------------- ACCEPT FOLLOW --------------------
exports.acceptFollow = async (req, res, next) => {
  const { followId } = req.body;

  try {
    const follow = await Follow.findById(followId);
    if (!follow) {
      return next(new HttpError("Follow request not found", 404));
    }

    if (follow.following.toString() !== req.userData.userId) {
      return next(new HttpError("Not authorized", 401));
    }

    follow.status = "accepted";
    await follow.save();

    res.json({ message: "Follow request accepted" });
  } catch (err) {
    return next(new HttpError("Accepting follow request failed", 500));
  }
};

// -------------------- REJECT FOLLOW --------------------
exports.rejectFollow = async (req, res, next) => {
  const { followId } = req.body;

  try {
    const follow = await Follow.findById(followId);
    if (!follow) {
      return next(new HttpError("Follow request not found", 404));
    }

    if (follow.following.toString() !== req.userData.userId) {
      return next(new HttpError("Not authorized", 401));
    }

    // Best practice: delete rejected request
    await Follow.findByIdAndDelete(followId);

    res.json({ message: "Follow request rejected" });
  } catch (err) {
    return next(new HttpError("Rejecting follow request failed", 500));
  }
};
