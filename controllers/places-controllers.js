import { validationResult } from "express-validator";
import mongoose from "mongoose";
import { v2 as cloudinary } from "cloudinary";
import axios from "axios";
import Sentiment from "sentiment";
import HttpError from "../models/http-error.js";
import Place from "../models/place.js";
import User from "../models/user.js";
import Follow from "../models/follow.js";
import Notification from "../models/notification.js";
import PushSubscription from "../models/pushSubscription.js";
import {
  deletePlaceRecord,
  isAlgoliaConfigured,
  savePlaceRecord,
  updatePlaceRecord,
} from "../config/algolia.js";
import {
  recordBusinessEvent,
  trackDatabaseOperation,
  trackExternalCall,
} from "../middleware/metrics.js";
import logger from "../util/logger.js";
import getCoordsForAddress from "../util/location.js";
import sendPush from "../util/push.js";

const analyzer = new Sentiment();
const placesLogger = logger.child({ component: "places-controller" });

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

const getRequestLogger = (req) =>
  req.logger?.child({ component: "places-controller" }) || placesLogger;

const detectCategories = (title = "", description = "") => {
  const searchableText = `${title} ${description}`.toLowerCase();

  return Object.entries(categoryMap).reduce((categories, [category, keywords]) => {
    if (keywords.some((keyword) => searchableText.includes(keyword))) {
      categories.push(category);
    }

    return categories;
  }, []);
};

const syncCreatedPlace = async (place, requestLogger) => {
  if (!isAlgoliaConfigured) {
    return;
  }

  try {
    await trackExternalCall("algolia", "save_place_record", () =>
      savePlaceRecord(place),
    );
  } catch (error) {
    requestLogger.error("Failed to sync created place to Algolia", {
      error,
      placeId: place._id.toString(),
    });
  }
};

const syncUpdatedPlace = async (place, requestLogger) => {
  if (!isAlgoliaConfigured) {
    return;
  }

  try {
    await trackExternalCall("algolia", "update_place_record", () =>
      updatePlaceRecord(place._id.toString(), {
        title: place.title,
        description: place.description,
        address: place.address,
        image: place.image,
        vibe: place.vibe,
        _geoloc: {
          lat: place.location_geo.coordinates[1],
          lng: place.location_geo.coordinates[0],
        },
      }),
    );
  } catch (error) {
    requestLogger.error("Failed to sync updated place to Algolia", {
      error,
      placeId: place._id.toString(),
    });
  }
};

const removePlaceFromAlgolia = async (placeId, requestLogger) => {
  if (!isAlgoliaConfigured) {
    return;
  }

  try {
    await trackExternalCall("algolia", "delete_place_record", () =>
      deletePlaceRecord(placeId),
    );
  } catch (error) {
    requestLogger.error("Failed to delete place from Algolia", {
      error,
      placeId,
    });
  }
};

const removePlaceImage = async (imagePath, requestLogger) => {
  if (!imagePath) {
    return;
  }

  const publicId = imagePath.split("/").pop()?.split(".")[0];

  if (!publicId) {
    return;
  }

  try {
    await trackExternalCall("cloudinary", "destroy_place_image", () =>
      cloudinary.uploader.destroy(publicId),
    );
  } catch (error) {
    requestLogger.warn("Failed to remove the place image from Cloudinary", {
      error,
      publicId,
    });
  }
};

const getPlaceById = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const placeId = req.params.pid;

  if (!mongoose.Types.ObjectId.isValid(placeId)) {
    requestLogger.warn("Place lookup failed because the id is invalid", {
      placeId,
    });
    return next(new HttpError("Invalid place ID.", 400));
  }

  let place;
  try {
    place = await trackDatabaseOperation("findById", "places", () =>
      Place.findById(placeId).lean({ virtuals: true }),
    );
  } catch (error) {
    requestLogger.error("Fetching place by id failed", { error, placeId });
    return next(new HttpError("Something went wrong, could not find a place", 500));
  }

  if (!place) {
    requestLogger.warn("Place lookup returned no result", { placeId });
    return next(new HttpError("Could not find a place for the provided id.", 404));
  }

  res.json({ place });
};

const getPlacesByUserId = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const userId = req.params.uid;

  if (!mongoose.isValidObjectId(userId)) {
    requestLogger.warn("User place lookup failed because the user id is invalid", {
      userId,
    });
    return next(new HttpError("Invalid user id", 400));
  }

  let places;
  try {
    places = await trackDatabaseOperation("find", "places", () =>
      Place.find(
        { creator: userId },
        {
          title: 1,
          description: 1,
          image: 1,
          address: 1,
          creator: 1,
          location_geo: 1,
        },
      ).lean(),
    );
  } catch (error) {
    requestLogger.error("Fetching places by user failed", { error, userId });
    return next(
      new HttpError("Fetching places failed, please try again later", 500),
    );
  }

  if (!places || places.length === 0) {
    requestLogger.warn("No places were found for the requested user", { userId });
    return next(
      new HttpError("Could not find places for the provided user id.", 404),
    );
  }

  res.json({ places });
};

const createPlace = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    recordBusinessEvent("place_create", "validation_failed");
    requestLogger.warn("Create place validation failed", {
      validationErrors: errors.array(),
      creatorId: req.userData.userId,
    });
    return next(
      new HttpError("Invalid inputs passed, please check your data", 422),
    );
  }

  const { title, description, address } = req.body;

  if (!req.file?.path) {
    recordBusinessEvent("place_create", "missing_image");
    requestLogger.warn("Create place failed because the image upload is missing", {
      creatorId: req.userData.userId,
    });
    return next(new HttpError("Image upload failed", 422));
  }

  if (!address || address.trim().length === 0) {
    recordBusinessEvent("place_create", "missing_address");
    requestLogger.warn("Create place failed because the address is missing", {
      creatorId: req.userData.userId,
    });
    return next(new HttpError("Address is required", 422));
  }

  let coordinates;
  try {
    coordinates = await getCoordsForAddress(address);
  } catch (error) {
    recordBusinessEvent("place_create", "geocode_failed");
    requestLogger.warn("Create place failed during address geocoding", {
      error,
      creatorId: req.userData.userId,
      address,
    });
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
    user = await trackDatabaseOperation("findById", "users", () =>
      User.findById(req.userData.userId),
    );
  } catch (error) {
    recordBusinessEvent("place_create", "database_error");
    requestLogger.error("Loading the creator failed during place creation", {
      error,
      creatorId: req.userData.userId,
    });
    return next(new HttpError("Creating place failed, please try again", 500));
  }

  if (!user) {
    recordBusinessEvent("place_create", "user_not_found");
    requestLogger.warn("Create place failed because the creator was not found", {
      creatorId: req.userData.userId,
    });
    return next(new HttpError("Could not find user for provided id", 404));
  }

  const sentimentResult = analyzer.analyze(description);
  const detectedCategories = detectCategories(title, description);

  if (sentimentResult.score > 0) {
    sentimentResult.positive.forEach((word) => {
      if (!user.affinities.includes(word)) {
        user.affinities.push(word);
      }
    });

    detectedCategories.forEach((category) => {
      if (!user.affinities.includes(category)) {
        user.affinities.push(category);
      }
    });
  }

  let session;
  try {
    await trackDatabaseOperation("transaction", "places", async () => {
      session = await mongoose.startSession();
      session.startTransaction();

      await createdPlace.save({ session });
      user.places.push(createdPlace);
      await user.save({ session });

      await session.commitTransaction();
    });
  } catch (error) {
    if (session?.inTransaction()) {
      try {
        await session.abortTransaction();
      } catch (abortError) {
        requestLogger.warn("Aborting the create place transaction failed", {
          abortError,
          creatorId: req.userData.userId,
        });
      }
    }

    recordBusinessEvent("place_create", "database_error");
    requestLogger.error("Create place transaction failed", {
      error,
      creatorId: req.userData.userId,
    });
    return next(new HttpError("Creating place failed, please try again", 500));
  } finally {
    session?.endSession();
  }

  recordBusinessEvent("place_create", "success");
  requestLogger.info("Place created", {
    placeId: createdPlace._id.toString(),
    creatorId: req.userData.userId,
    detectedCategories,
    positiveSentiment: sentimentResult.score > 0,
  });

  await syncCreatedPlace(createdPlace, requestLogger);

  try {
    const followers = await trackDatabaseOperation("find", "follows", () =>
      Follow.find({
        following: req.userData.userId,
        status: "accepted",
      }),
    );

    for (const follower of followers) {
      await trackDatabaseOperation("insert", "notifications", () =>
        Notification.create({
          recipient: follower.follower,
          sender: req.userData.userId,
          type: "NEW_PLACE",
          message: `${user.name} added a new place`,
          link: `/${req.userData.userId}/places`,
        }),
      );

      const sub = await trackDatabaseOperation(
        "findOne",
        "pushSubscriptions",
        () => PushSubscription.findOne({ user: follower.follower }),
      );

      if (sub) {
        void sendPush(sub.subscription, {
          title: `${user.name} added a new place`,
          body: createdPlace.title || "New place added",
          url: `/${req.userData.userId}/places`,
        });
      }

    }

    requestLogger.debug("Follower notifications processed for a new place", {
      placeId: createdPlace._id.toString(),
      followerCount: followers.length,
    });
  } catch (error) {
    requestLogger.error("Sending new place notifications failed", {
      error,
      placeId: createdPlace._id.toString(),
      creatorId: req.userData.userId,
    });
  }

  res.status(201).json({
    place: createdPlace.toObject({ virtuals: true }),
  });
};

const updatePlace = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    recordBusinessEvent("place_update", "validation_failed");
    requestLogger.warn("Update place validation failed", {
      validationErrors: errors.array(),
      placeId: req.params.pid,
      userId: req.userData.userId,
    });
    return next(
      new HttpError("Invalid inputs passed, please check your data", 422),
    );
  }

  const { title, description } = req.body;
  const placeId = req.params.pid;

  let place;
  try {
    place = await trackDatabaseOperation("findById", "places", () =>
      Place.findById(placeId),
    );
  } catch (error) {
    recordBusinessEvent("place_update", "database_error");
    requestLogger.error("Loading the place failed during update", {
      error,
      placeId,
      userId: req.userData.userId,
    });
    return next(new HttpError("Something went wrong, could not update place", 500));
  }

  if (!place) {
    recordBusinessEvent("place_update", "not_found");
    requestLogger.warn("Update place failed because the place was not found", {
      placeId,
      userId: req.userData.userId,
    });
    return next(new HttpError("Could not find place for this id.", 404));
  }

  if (place.creator.toString() !== req.userData.userId) {
    recordBusinessEvent("place_update", "unauthorized");
    requestLogger.warn("Update place failed because the user is not authorized", {
      placeId,
      userId: req.userData.userId,
    });
    return next(new HttpError("You are not allowed to edit this place.", 401));
  }

  place.title = title;
  place.description = description;

  try {
    await trackDatabaseOperation("save", "places", () => place.save());
  } catch (error) {
    recordBusinessEvent("place_update", "database_error");
    requestLogger.error("Persisting the updated place failed", {
      error,
      placeId,
      userId: req.userData.userId,
    });
    return next(new HttpError("Something went wrong, could not update place", 500));
  }

  recordBusinessEvent("place_update", "success");
  requestLogger.info("Place updated", {
    placeId,
    userId: req.userData.userId,
  });

  await syncUpdatedPlace(place, requestLogger);

  res.status(200).json({ place: place.toObject({ getters: true }) });
};

const deletePlace = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const placeId = req.params.pid;

  let place;
  try {
    place = await trackDatabaseOperation("findById", "places", () =>
      Place.findById(placeId).populate("creator"),
    );
  } catch (error) {
    recordBusinessEvent("place_delete", "database_error");
    requestLogger.error("Loading the place failed during deletion", {
      error,
      placeId,
      userId: req.userData.userId,
    });
    return next(
      new HttpError("Something went wrong, could not delete place.", 500),
    );
  }

  if (!place) {
    recordBusinessEvent("place_delete", "not_found");
    requestLogger.warn("Delete place failed because the place was not found", {
      placeId,
      userId: req.userData.userId,
    });
    return next(new HttpError("Could not find place for this id.", 404));
  }

  if (place.creator.id !== req.userData.userId) {
    recordBusinessEvent("place_delete", "unauthorized");
    requestLogger.warn("Delete place failed because the user is not authorized", {
      placeId,
      userId: req.userData.userId,
    });
    return next(new HttpError("You are not allowed to delete this place.", 401));
  }

  const imagePath = place.image;
  let session;

  try {
    await trackDatabaseOperation("transaction", "places", async () => {
      session = await mongoose.startSession();
      session.startTransaction();

      await Place.deleteOne({ _id: placeId }).session(session);
      place.creator.places.pull(place);
      await place.creator.save({ session });

      await session.commitTransaction();
    });
  } catch (error) {
    if (session?.inTransaction()) {
      try {
        await session.abortTransaction();
      } catch (abortError) {
        requestLogger.warn("Aborting the delete place transaction failed", {
          abortError,
          placeId,
          userId: req.userData.userId,
        });
      }
    }

    recordBusinessEvent("place_delete", "database_error");
    requestLogger.error("Delete place transaction failed", {
      error,
      placeId,
      userId: req.userData.userId,
    });
    return next(
      new HttpError("Something went wrong, could not delete place.", 500),
    );
  } finally {
    session?.endSession();
  }

  recordBusinessEvent("place_delete", "success");
  requestLogger.info("Place deleted", {
    placeId,
    userId: req.userData.userId,
  });

  await removePlaceFromAlgolia(placeId, requestLogger);
  await removePlaceImage(imagePath, requestLogger);

  res.status(200).json({ message: "Deleted place." });
};

const getNearbyPlaces = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const { lng, lat } = req.query;
  const userId = req.userData.userId;

  try {
    const user = await trackDatabaseOperation("findById", "users", () =>
      User.findById(userId).lean(),
    );
    const userLikes = user ? user.affinities : [];

    let dbPlaces = await trackDatabaseOperation("find", "places", () =>
      Place.find({
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
        .lean({ virtuals: true }),
    );

    let googlePlaces = [];
    if (dbPlaces.length < 5) {
      const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;
      const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=5000&key=${googleApiKey}`;
      const response = await trackExternalCall(
        "google_places",
        "nearby_search",
        () => axios.get(url),
      );
      googlePlaces = response.data.results;
    }

    const allPlaces = [
      ...dbPlaces.map((place) => ({ ...place, source: "db" })),
      ...googlePlaces.map((place) => ({ ...place, source: "google" })),
    ];

    const processedPlaces = allPlaces.map((place) => {
      const searchText = `${place.title || place.name} ${
        place.description || ""
      }`.toLowerCase();
      const sentimentResult = analyzer.analyze(searchText);

      const matchCount = userLikes.reduce((count, like) => {
        const regex = new RegExp(`\\b${like}\\b`, "i");
        return regex.test(searchText) ? count + 1 : count;
      }, 0);

      return {
        id: place._id || place.place_id,
        title: place.title || place.name,
        address: place.address || place.vicinity,
        location: place.location || place.geometry.location,
        image:
          place.image ||
          (place.photos
            ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${place.photos[0].photo_reference}&key=${process.env.GOOGLE_MAPS_API_KEY}`
            : ""),
        vibe: place.vibe || (sentimentResult.score > 0 ? "Positive" : "Neutral"),
        matchScore: matchCount,
        isRecommended: matchCount > 0 && sentimentResult.score >= 0,
        source: place.source,
      };
    });

    processedPlaces.sort((left, right) => right.matchScore - left.matchScore);

    res.json({ places: processedPlaces });
  } catch (error) {
    requestLogger.error("Nearby place discovery failed", {
      error,
      userId,
      lng,
      lat,
    });
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
