const mongoose = require("mongoose");
const leanVirtuals = require("mongoose-lean-virtuals");
const Sentiment = require("sentiment"); // 1. Import
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

// 1. Create the Geospatial Index
placeSchema.index({ location_geo: "2dsphere" });

// 2. Create the Virtual 'location' field
placeSchema.virtual("location").get(function () {
  return {
    lng: this.location_geo.coordinates[0],
    lat: this.location_geo.coordinates[1],
  };
});

// 2. Add the Vibe Virtual Field Plugin
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

module.exports = mongoose.model("Place", placeSchema);
