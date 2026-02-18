import PushSubscription from "../models/pushSubscription.js";
import HttpError from "../models/http-error.js";

// -------------------- SUBSCRIBE --------------------
export const subscribe = async (req, res, next) => {
  const { subscription } = req.body;

  if (!subscription) {
    return next(new HttpError("Subscription data missing", 422));
  }

  try {
    await PushSubscription.findOneAndUpdate(
      { user: req.userData.userId },
      { subscription },
      { upsert: true, new: true }
    );

    res.status(201).json({ message: "Push subscription saved" });
  } catch (err) {
    return next(new HttpError("Saving push subscription failed", 500));
  }
};

// -------------------- UNSUBSCRIBE --------------------
export const unsubscribe = async (req, res, next) => {
  try {
    await PushSubscription.findOneAndDelete({
      user: req.userData.userId,
    });

    res.json({ message: "Push subscription removed" });
  } catch (err) {
    return next(new HttpError("Removing push subscription failed", 500));
  }
};
