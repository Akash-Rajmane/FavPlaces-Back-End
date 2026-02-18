import mongoose from "mongoose";

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

export default mongoose.model("PushSubscription", pushSubscriptionSchema);
