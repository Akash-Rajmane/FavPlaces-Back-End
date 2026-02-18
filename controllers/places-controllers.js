import { validationResult } from "express-validator";
import mongoose from "mongoose";
import { v2 as cloudinary } from "cloudinary";
import axios from "axios";
import HttpError from "../models/http-error.js";
import getCoordsForAddress from "../util/location.js";
import Sentiment from "sentiment";
import Place from "../models/place.js";
import User from "../models/user.js";
import Follow from "../models/follow.js";
import Notification from "../models/notification.js";
import PushSubscription from "../models/pushSubscription.js";
import sendPush from "../util/push.js";

const analyzer = new Sentiment();

// -------------------- GET PLACE BY ID --------------------
const getPlaceById = async (req, res, next) => {
  const placeId = req.params.pid;

  if (!mongoose.Types.ObjectId.isValid(placeId)) {
    return next(new HttpError("Invalid place ID.", 400));
  }

  let place;
  try {
    place = await Place.findById(placeId).lean({ virtuals: true });
  } catch (err) {
    return next(
      new HttpError("Something went wrong, could not find a place", 500)
    );
  }

  if (!place) {
    return next(
      new HttpError("Could not find a place for the provided id.", 404)
    );
  }

  res.json({ place });
};

// -------------------- GET PLACES BY USER --------------------
const getPlacesByUserId = async (req, res, next) => {
  const userId = req.params.uid;
  if (!mongoose.isValidObjectId(userId)) {
    return next(new HttpError("Invalid user id", 400));
  }

  let places;
  try {
    places = await Place.find(
      { creator: userId },
      {
        title: 1,
        description: 1,
        image: 1,
        address: 1,
        creator: 1,
        location_geo: 1,
      }
    ).lean();
  } catch (err) {
    return next(
      new HttpError("Fetching places failed, please try again later", 500)
    );
  }

  if (!places || places.length === 0) {
    return next(
      new HttpError("Could not find places for the provided user id.", 404)
    );
  }

  res.json({ places });
};

// -------------------- CREATE PLACE (WITH NOTIFICATION) --------------------
const createPlace = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(
      new HttpError("Invalid inputs passed, please check your data", 422)
    );
  }

  const { title, description, address } = req.body;

  if (!req.file) return next(new HttpError("Image upload failed", 422));
  if (!address || address.trim().length === 0)
    return next(new HttpError("Address is required", 422));

  let coordinates;
  try {
    coordinates = await getCoordsForAddress(address);
  } catch (error) {
    return next(error);
  }

  const createdPlace = new Place({
    title,
    description,
    address,
    location_geo: {
      type: "Point",
      coordinates: [coordinates.lng, coordinates.lat],
    },
    image: req.file.path,
    creator: req.userData.userId,
  });

  let user;
  try {
    user = await User.findById(req.userData.userId);
  } catch (err) {
    return next(new HttpError("Creating place failed, please try again", 500));
  }

  if (!user)
    return next(new HttpError("Could not find user for provided id", 404));

  // --- 🧠 AI & AFFINITY LOGIC START ---

  // 1. Sentiment Analysis: Only learn if the user likes the place
  const sentimentResult = analyzer.analyze(description);

  // 2. Automated Category Classification
  const text = (title + " " + description).toLowerCase();
  const categoryMap = {
    Nature: ["park", "garden", "forest", "hiking", "lake", "outdoor", "view"],
    Foodie: [
      "cafe",
      "restaurant",
      "delicious",
      "coffee",
      "tasty",
      "brunch",
      "dinner",
    ],
    Culture: ["museum", "art", "gallery", "history", "monument", "castle"],
    Nightlife: ["bar", "pub", "club", "party", "drinks", "music"],
  };

  let detectedCategories = [];
  for (const [category, keywords] of Object.entries(categoryMap)) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      detectedCategories.push(category);
    }
  }

  // 3. Update User Affinities based on Sentiment
  if (sentimentResult.score > 0) {
    // Add positive sentiment words (e.g., "cozy", "beautiful")
    sentimentResult.positive.forEach((word) => {
      if (!user.affinities.includes(word)) user.affinities.push(word);
    });

    // Add detected categories to user profile (e.g., "Foodie")
    detectedCategories.forEach((cat) => {
      if (!user.affinities.includes(cat)) user.affinities.push(cat);
    });
  }

  // --- 🧠 AI & AFFINITY LOGIC END ---

  try {
    const session = await mongoose.startSession();
    session.startTransaction();

    await createdPlace.save({ session });
    user.places.push(createdPlace);
    await user.save({ session });

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    return next(new HttpError("Creating place failed, please try again", 500));
  }

  // 🔔 NOTIFICATIONS (Best-effort logic kept as is)
  try {
    const followers = await Follow.find({
      following: req.userData.userId,
      status: "accepted",
    });
    for (const f of followers) {
      await Notification.create({
        recipient: f.follower,
        sender: req.userData.userId,
        type: "NEW_PLACE",
        message: `${user.name} added a new place 📍`,
        link: `/places/user/${req.userData.userId}`,
      });
      // ... (Push subscription logic)
      // after await Notification.create({...})
      const sub = await PushSubscription.findOne({ user: f.follower });
      if (sub) {
        try {
          sendPush(sub.subscription, {
            title: `${user.name} added a new place 📍`,
            body: createdPlace.title || "New place added",
            url: `/places/user/${req.userData.userId}`,
          });
        } catch (err) {
          console.error("Send place push failed:", err.message);
        }
      }
    }
  } catch (err) {
    console.error("Notification error:", err.message);
  }

  res.status(201).json({
    place: createdPlace.toObject({ virtuals: true }),
  });
};

// -------------------- UPDATE PLACE --------------------
const updatePlace = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new HttpError("Invalid inputs passed, please check your data", 422);
  }

  const { title, description } = req.body;
  const placeId = req.params.pid;

  let place;
  try {
    place = await Place.findById(placeId);
  } catch (err) {
    return next(
      new HttpError("Something went wrong, could not update place", 500)
    );
  }

  if (place.creator.toString() !== req.userData.userId) {
    return next(new HttpError("You are not allowed to edit this place.", 401));
  }

  place.title = title;
  place.description = description;

  try {
    await place.save();
  } catch (err) {
    return next(
      new HttpError("Something went wrong, could not update place", 500)
    );
  }

  res.status(200).json({ place: place.toObject({ getters: true }) });
};

// -------------------- DELETE PLACE --------------------
const deletePlace = async (req, res, next) => {
  const placeId = req.params.pid;

  let place;
  try {
    place = await Place.findById(placeId).populate("creator");
  } catch (err) {
    return next(
      new HttpError("Something went wrong, could not delete place.", 500)
    );
  }

  if (!place) {
    return next(new HttpError("Could not find place for this id.", 404));
  }

  if (place.creator.id !== req.userData.userId) {
    return next(
      new HttpError("You are not allowed to delete this place.", 401)
    );
  }

  const imagePath = place.image;

  try {
    const session = await mongoose.startSession();
    session.startTransaction();

    await Place.deleteOne({ _id: placeId }).session(session);
    place.creator.places.pull(place);
    await place.creator.save({ session });

    await session.commitTransaction();
  } catch (err) {
    return next(
      new HttpError("Something went wrong, could not delete place.", 500)
    );
  }

  const publicId = imagePath.split("/").pop().split(".")[0];
  cloudinary.uploader.destroy(publicId);

  res.status(200).json({ message: "Deleted place." });
};

// -------------------------- GET NEARBY PLACES ------------------------

const getNearbyPlaces = async (req, res, next) => {
  const { lng, lat } = req.query;
  const userId = req.userData.userId;

  try {
    // 1. Get User to access the 'affinities' array
    const user = await User.findById(userId).lean();
    // We use the full affinities list for better AI matching accuracy
    const userLikes = user ? user.affinities : [];

    // 2. Fetch from MongoDB (Geospatial Search)
    let dbPlaces = await Place.find({
      location_geo: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [parseFloat(lng), parseFloat(lat)],
          },
          $maxDistance: 10000,
        },
      },
    })
      .limit(10)
      .lean({ virtuals: true });

    // 3. Fetch from Google if local DB results are low
    let googlePlaces = [];
    if (dbPlaces.length < 5) {
      const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;
      // We search for general 'points of interest' to get a variety of categories
      const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=5000&key=${googleApiKey}`;
      const response = await axios.get(url);
      googlePlaces = response.data.results;
    }

    // 4. Combine and Process
    const allPlaces = [
      ...dbPlaces.map((p) => ({ ...p, source: "db" })),
      ...googlePlaces.map((p) => ({ ...p, source: "google" })),
    ];

    const processedPlaces = allPlaces.map((p) => {
      // Create a search string from title and description for matching
      const searchText = `${p.title || p.name} ${
        p.description || ""
      }`.toLowerCase();
      const sentimentResult = analyzer.analyze(searchText);

      // 🧠 AI Matching Logic:
      // Count how many times the user's saved 'affinities' appear in this place
      const matchCount = userLikes.reduce((acc, like) => {
        const regex = new RegExp(`\\b${like}\\b`, "i"); // \b is a word boundary
        return regex.test(searchText) ? acc + 1 : acc;
      }, 0);

      return {
        id: p._id || p.place_id,
        title: p.title || p.name,
        address: p.address || p.vicinity,
        location: p.location || p.geometry.location,
        image:
          p.image ||
          (p.photos
            ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${p.photos[0].photo_reference}&key=${process.env.GOOGLE_MAPS_API_KEY}`
            : ""),

        // AI Metadata
        vibe:
          p.vibe || (sentimentResult.score > 0 ? "Positive 🙂" : "Neutral 😶"),
        matchScore: matchCount, // This is the 'Affinity' logic
        isRecommended: matchCount > 0 && sentimentResult.score >= 0,
        source: p.source,
      };
    });

    // 5. Final Ranking: Highest Match Score first, then distance/sentiment
    processedPlaces.sort((a, b) => b.matchScore - a.matchScore);

    res.json({ places: processedPlaces });
  } catch (err) {
    console.error(err);
    next(new HttpError("Discovery failed", 500));
  }
};

export {
  getPlaceById,
  getPlacesByUserId,
  createPlace,
  updatePlace,
  deletePlace,
};
