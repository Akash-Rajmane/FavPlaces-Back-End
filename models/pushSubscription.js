const mongoose = require("mongoose");

const Schema = mongoose.Schema;

const pushSubscriptionSchema = new Schema({
  user: {
    type: mongoose.Types.ObjectId,
    ref: "User",
    unique: true,
    required: true,
  },
  subscription: {
    type: Object,
    required: true,
  },
});

module.exports = mongoose.model("PushSubscription", pushSubscriptionSchema);
