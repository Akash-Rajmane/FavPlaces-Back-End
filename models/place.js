import mongoose from "mongoose";
import leanVirtuals from "mongoose-lean-virtuals";
import Sentiment from "sentiment";

const sentiment = new Sentiment();
const Schema = mongoose.Schema;

const placeSchema = new Schema({
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
  image: {
    type: String,
    required: true,
  },
  address: {
    type: String,
    required: true,
  },
  location_geo: {
    type: { type: String, default: "Point" },
    coordinates: { type: [Number], required: true }, // [lng, lat]
  },
  creator: {
    type: mongoose.Types.ObjectId,
    required: true,
    ref: "User",
  },
});

// Create the Geospatial Index
placeSchema.index({ location_geo: "2dsphere" });

//  Add the Vibe Virtual Field Plugin
placeSchema.virtual("vibe").get(function () {
  if (!this.description) return "Neutral 😶";
  const result = sentiment.analyze(this.description);

  if (result.score > 2) return "Amazing ✨";
  if (result.score > 0) return "Positive 🙂";
  if (result.score < 0) return "Critical 🚩";
  return "Neutral 😶";
});

placeSchema.plugin(leanVirtuals);

// 3. Ensure the virtual is included when sending data to React
placeSchema.set("toJSON", { virtuals: true });
placeSchema.set("toObject", { virtuals: true });

export default mongoose.model("Place", placeSchema);
