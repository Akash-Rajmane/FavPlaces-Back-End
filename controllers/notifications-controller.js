const Notification = require("../models/notification");
const HttpError = require("../models/http-error");

// GET /api/notifications
exports.getNotifications = async (req, res, next) => {
  try {
    const notifications = await Notification.find({
      recipient: req.userData.userId,
    })
      .sort({ createdAt: -1 })
      .populate("sender", "name image")
      .lean({ virtuals: true });

    res.json({ notifications });
  } catch (err) {
    return next(new HttpError("Fetching notifications failed", 500));
  }
};

// PATCH /api/notifications/:nid/read
exports.markAsRead = async (req, res, next) => {
  const nid = req.params.nid;

  try {
    const notification = await Notification.findById(nid);
    if (!notification)
      return next(new HttpError("Notification not found", 404));
    if (notification.recipient.toString() !== req.userData.userId) {
      return next(new HttpError("Not authorized", 401));
    }

    notification.isRead = true;
    await notification.save();

    res.json({ message: "Marked as read" });
  } catch (err) {
    return next(new HttpError("Updating notification failed", 500));
  }
};
