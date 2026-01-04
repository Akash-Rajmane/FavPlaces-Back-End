const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");

const Schema = mongoose.Schema;

const userSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true, minlength: 8 },
  image: { type: String, required: true },
  places: [
    {
      type: mongoose.Types.ObjectId,
      required: true,
      ref: "Place",
    },
  ],
  // 🧠 AI & DISCOVERY DATA
  // Stores sentiment-positive words and detected categories (e.g., "Foodie", "cozy")
  affinities: [
    {
      type: String,
    },
  ],
});

// 1. Create a Virtual to display the user's most recent unique interests
userSchema.virtual("topInterests").get(function () {
  if (!this.affinities) return [];
  // Returns unique tags, limiting to the 5 most recent ones
  return [...new Set(this.affinities)].slice(-5);
});

// 2. Ensure virtuals are included when sending data to the React frontend
userSchema.set("toJSON", { virtuals: true });
userSchema.set("toObject", { virtuals: true });

userSchema.plugin(uniqueValidator);

module.exports = mongoose.model("User", userSchema);
