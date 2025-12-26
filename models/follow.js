const mongoose = require("mongoose");

const Schema = mongoose.Schema;

const followSchema = new Schema(
  {
    follower: {
      type: mongoose.Types.ObjectId,
      ref: "User",
      required: true,
    },
    following: {
      type: mongoose.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted"],
      default: "pending",
    },
  },
  { timestamps: true }
);

// Prevent duplicate follow requests
followSchema.index({ follower: 1, following: 1 }, { unique: true });

module.exports = mongoose.model("Follow", followSchema);
