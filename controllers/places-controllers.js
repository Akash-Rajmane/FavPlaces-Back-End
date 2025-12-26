const { validationResult } = require("express-validator");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;

const HttpError = require("../models/http-error");
const getCoordsForAddress = require("../util/location");

const Place = require("../models/place");
const User = require("../models/user");

// 🔔 NEW IMPORTS
const Follow = require("../models/follow");
const Notification = require("../models/notification");
const PushSubscription = require("../models/pushSubscription");
const sendPush = require("../util/push");

// -------------------- GET PLACE BY ID --------------------
const getPlaceById = async (req, res, next) => {
  const placeId = req.params.pid;

  if (!mongoose.Types.ObjectId.isValid(placeId)) {
    return next(new HttpError("Invalid place ID.", 400));
  }

  let place;
  try {
    place = await Place.findById(placeId).lean();
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

  let places;
  try {
    places = await Place.find({ creator: userId }).lean({ virtuals: true });
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
    location: coordinates,
    image: req.file.path,
    creator: req.userData.userId,
  });

  let user;
  try {
    user = await User.findById(req.userData.userId);
  } catch (err) {
    return next(new HttpError("Creating place failed, please try again", 500));
  }

  if (!user) {
    return next(new HttpError("Could not find user for provided id", 404));
  }

  try {
    const session = await mongoose.startSession();
    session.startTransaction();

    await createdPlace.save({ session });
    user.places.push(createdPlace);
    await user.save({ session });

    await session.commitTransaction();
  } catch (err) {
    return next(new HttpError("Creating place failed, please try again", 500));
  }

  // 🔔 NOTIFY FOLLOWERS (AFTER PLACE IS SAVED)
  try {
    const followers = await Follow.find({
      following: req.userData.userId,
      status: "accepted",
    });

    for (const f of followers) {
      // Save in-app notification
      await Notification.create({
        recipient: f.follower,
        sender: req.userData.userId,
        type: "NEW_PLACE",
        message: `${user.name} added a new place 📍`,
        link: `/places/user/${req.userData.userId}`,
      });

      // Push notification
      const sub = await PushSubscription.findOne({
        user: f.follower,
      });

      if (sub) {
        sendPush(sub.subscription, {
          title: "New Place Added 📍",
          body: `${user.name} added a new place`,
          url: `/places/user/${req.userData.userId}`,
        });
      }
    }
  } catch (err) {
    console.error("Notification error:", err.message);
    // ❗ Do NOT fail the API if notification fails
  }

  res.status(201).json({
    place: createdPlace.toObject({ getters: true }),
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

exports.getPlaceById = getPlaceById;
exports.getPlacesByUserId = getPlacesByUserId;
exports.createPlace = createPlace;
exports.updatePlace = updatePlace;
exports.deletePlace = deletePlace;
