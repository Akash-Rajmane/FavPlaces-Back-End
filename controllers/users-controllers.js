import { validationResult } from "express-validator";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import HttpError from "../models/http-error.js";
import User from "../models/user.js";

const getUsers = async (req, res, next) => {
  let viewerId = null;

  if (req.userData?.userId && mongoose.isValidObjectId(req.userData.userId)) {
    viewerId = new mongoose.Types.ObjectId(req.userData.userId);
  }

  try {
    // 🔒 Not logged in OR invalid id → fast path
    if (!viewerId) {
      const users = await User.find(
        {},
        { name: 1, image: 1, places: 1 }
      ).lean();

      return res.json({ users });
    }

    // 🔓 Logged-in → aggregation
    const users = await User.aggregate([
      {
        $project: {
          name: 1,
          image: 1,
          places: 1,
        },
      },
      {
        $lookup: {
          from: "follows",
          let: { targetUserId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$follower", viewerId] },
                    { $eq: ["$following", "$$targetUserId"] },
                  ],
                },
              },
            },
            { $project: { status: 1, _id: 0 } },
          ],
          as: "followData",
        },
      },
      {
        $addFields: {
          followStatus: {
            $cond: [
              { $eq: ["$_id", viewerId] },
              "$$REMOVE",
              {
                $ifNull: [{ $arrayElemAt: ["$followData.status", 0] }, "none"],
              },
            ],
          },
        },
      },
      { $project: { followData: 0 } },
    ]);

    res.json({ users });
  } catch (err) {
    console.error(err);
    return next(new HttpError("Fetching users failed", 500));
  }
};

const signup = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(
      new HttpError("Invalid inputs passed, please check your data.", 422)
    );
  }
  const { name, email, password } = req.body;

  let existingUser;
  try {
    existingUser = await User.findOne({ email: email }).lean();
  } catch (err) {
    const error = new HttpError(
      "Signing up failed, please try again later.",
      500
    );
    return next(error);
  }

  if (existingUser) {
    const error = new HttpError(
      "User exists already, please login instead.",
      422
    );
    return next(error);
  }

  let hashedPassword;
  try {
    hashedPassword = await bcrypt.hash(password, 12);
  } catch (err) {
    const error = new HttpError(
      "Could not create user, please try again.",
      500
    );
    return next(error);
  }

  const createdUser = new User({
    name,
    email,
    image: req.file.path,
    password: hashedPassword,
    places: [],
  });

  try {
    await createdUser.save();
  } catch (err) {
    const error = new HttpError(
      "Signing up failed, please try again later.",
      500
    );
    return next(error);
  }

  let token;
  try {
    token = jwt.sign(
      { userId: createdUser.id, email: createdUser.email },
      `${process.env.JWT_KEY}`,
      { expiresIn: "1h" }
    );
  } catch (err) {
    const error = new HttpError(
      "Signing up failed, please try again later.",
      500
    );
    return next(error);
  }

  res
    .status(201)
    .json({ userId: createdUser.id, email: createdUser.email, token: token });
};

const login = async (req, res, next) => {
  const { email, password } = req.body;

  let existingUser;

  try {
    existingUser = await User.findOne({ email: email }).lean({
      virtuals: true,
    });
  } catch (err) {
    const error = new HttpError(
      "Logging in failed, please try again later",
      500
    );
    return next(error);
  }

  if (!existingUser) {
    const error = new HttpError(
      "User does not exist, so could not log you in",
      401
    );
    return next(error);
  }

  let isValidPassword = false;
  try {
    isValidPassword = await bcrypt.compare(password, existingUser.password);
  } catch (err) {
    const error = new HttpError(
      "Could not log you in, please check your credentials & try again",
      500
    );
    return next(error);
  }

  if (!isValidPassword) {
    const error = new HttpError(
      "Invalid credentials, so could not log you in",
      403
    );
    return next(error);
  }

  let token;
  try {
    token = jwt.sign(
      { userId: existingUser._id, email: existingUser.email },
      `${process.env.JWT_KEY}`,
      { expiresIn: "1h" }
    );
  } catch (err) {
    const error = new HttpError(
      "Logging in failed, please try again later.",
      500
    );
    return next(error);
  }

  res.json({
    userId: existingUser._id,
    email: existingUser.email,
    token: token,
  });
};

export { getUsers, signup, login };
