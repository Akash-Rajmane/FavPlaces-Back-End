const mongoose = require("mongoose");

const Schema = mongoose.Schema;

const notificationSchema = new Schema(
  {
    recipient: {
      type: mongoose.Types.ObjectId,
      ref: "User",
      required: true,
    },
    sender: {
      type: mongoose.Types.ObjectId,
      ref: "User",
    },
    type: {
      type: String,
      enum: ["FOLLOW_REQUEST", "NEW_PLACE"],
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    link: {
      type: String, // frontend route
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
