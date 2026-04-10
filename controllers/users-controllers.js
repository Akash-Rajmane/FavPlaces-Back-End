import { validationResult } from "express-validator";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import HttpError from "../models/http-error.js";
import User from "../models/user.js";
import cacheKeys from "../util/cache-keys.js";
import { deleteKeys, remember } from "../util/cache.js";
import logger, { maskEmail } from "../util/logger.js";
import {
  recordAuthEvent,
  recordBusinessEvent,
  trackDatabaseOperation,
} from "../middleware/metrics.js";

const usersLogger = logger.child({ component: "users-controller" });

const getRequestLogger = (req) =>
  req.logger?.child({ component: "users-controller" }) || usersLogger;

const getUsers = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  let viewerId = null;

  if (req.userData?.userId && mongoose.isValidObjectId(req.userData.userId)) {
    viewerId = new mongoose.Types.ObjectId(req.userData.userId);
  }

  try {
    if (!viewerId) {
      const { value: users, cacheHit } = await remember(
        cacheKeys.publicUsers(),
        120,
        () =>
          trackDatabaseOperation("find", "users", () =>
            User.find({}, { name: 1, image: 1, places: 1 }).lean(),
          ),
      );

      requestLogger.debug("Fetched public users list", { cacheHit });

      return res.json({ users });
    }

    const users = await trackDatabaseOperation("aggregate", "users", () =>
      User.aggregate([
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
      ]),
    );

    res.json({ users });
  } catch (error) {
    requestLogger.error("Fetching users failed", { error, viewerId });
    return next(new HttpError("Fetching users failed", 500));
  }
};

const signup = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    recordBusinessEvent("user_signup", "validation_failed");
    requestLogger.warn("Signup validation failed", {
      validationErrors: errors.array(),
    });
    return next(
      new HttpError("Invalid inputs passed, please check your data.", 422),
    );
  }

  const { name, email, password } = req.body;
  const maskedEmail = maskEmail(email);

  if (!req.file?.path) {
    recordBusinessEvent("user_signup", "missing_image");
    requestLogger.warn("Signup failed because image upload is missing", {
      email: maskedEmail,
    });
    return next(new HttpError("Image upload failed, please try again.", 422));
  }

  let existingUser;
  try {
    existingUser = await trackDatabaseOperation("findOne", "users", () =>
      User.findOne({ email }).lean(),
    );
  } catch (error) {
    recordBusinessEvent("user_signup", "database_error");
    requestLogger.error("Failed to check for existing user during signup", {
      error,
      email: maskedEmail,
    });
    return next(new HttpError("Signing up failed, please try again later.", 500));
  }

  if (existingUser) {
    recordBusinessEvent("user_signup", "already_exists");
    requestLogger.warn("Signup blocked because the user already exists", {
      email: maskedEmail,
    });
    return next(new HttpError("User exists already, please login instead.", 422));
  }

  let hashedPassword;
  try {
    hashedPassword = await bcrypt.hash(password, 12);
  } catch (error) {
    recordBusinessEvent("user_signup", "hash_error");
    requestLogger.error("Password hashing failed during signup", {
      error,
      email: maskedEmail,
    });
    return next(new HttpError("Could not create user, please try again.", 500));
  }

  const createdUser = new User({
    name,
    email,
    image: req.file.path,
    password: hashedPassword,
    places: [],
  });

  try {
    await trackDatabaseOperation("insert", "users", () => createdUser.save());
  } catch (error) {
    recordBusinessEvent("user_signup", "database_error");
    requestLogger.error("Persisting a new user failed during signup", {
      error,
      email: maskedEmail,
    });
    return next(new HttpError("Signing up failed, please try again later.", 500));
  }

  let token;
  try {
    token = jwt.sign(
      { userId: createdUser.id, email: createdUser.email },
      `${process.env.JWT_KEY}`,
      { expiresIn: "1h" },
    );
  } catch (error) {
    recordBusinessEvent("user_signup", "token_error");
    requestLogger.error("Token generation failed during signup", {
      error,
      userId: createdUser.id,
      email: maskedEmail,
    });
    return next(new HttpError("Signing up failed, please try again later.", 500));
  }

  recordBusinessEvent("user_signup", "success");
  await deleteKeys(cacheKeys.publicUsers());
  requestLogger.info("User signed up", {
    userId: createdUser.id,
    email: maskedEmail,
  });

  res.status(201).json({
    userId: createdUser.id,
    email: createdUser.email,
    name: createdUser.name,
    image: createdUser.image,
    token,
  });
};

const login = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const { email, password } = req.body;
  const maskedEmail = maskEmail(email);

  let existingUser;
  try {
    existingUser = await trackDatabaseOperation("findOne", "users", () =>
      User.findOne({ email }).lean({ virtuals: true }),
    );
  } catch (error) {
    recordAuthEvent("login", "database_error");
    recordBusinessEvent("user_login", "database_error");
    requestLogger.error("User lookup failed during login", {
      error,
      email: maskedEmail,
    });
    return next(new HttpError("Logging in failed, please try again later", 500));
  }

  if (!existingUser) {
    recordAuthEvent("login", "user_not_found");
    recordBusinessEvent("user_login", "user_not_found");
    requestLogger.warn("Login failed because the user was not found", {
      email: maskedEmail,
    });
    return next(new HttpError("User does not exist, so could not log you in", 401));
  }

  let isValidPassword = false;
  try {
    isValidPassword = await bcrypt.compare(password, existingUser.password);
  } catch (error) {
    recordAuthEvent("login", "compare_error");
    recordBusinessEvent("user_login", "compare_error");
    requestLogger.error("Password comparison failed during login", {
      error,
      userId: existingUser._id.toString(),
      email: maskedEmail,
    });
    return next(
      new HttpError(
        "Could not log you in, please check your credentials & try again",
        500,
      ),
    );
  }

  if (!isValidPassword) {
    recordAuthEvent("login", "invalid_credentials");
    recordBusinessEvent("user_login", "invalid_credentials");
    requestLogger.warn("Login failed because the password was invalid", {
      userId: existingUser._id.toString(),
      email: maskedEmail,
    });
    return next(new HttpError("Invalid credentials, so could not log you in", 403));
  }

  let token;
  try {
    token = jwt.sign(
      { userId: existingUser._id, email: existingUser.email },
      `${process.env.JWT_KEY}`,
      { expiresIn: "1h" },
    );
  } catch (error) {
    recordAuthEvent("login", "token_error");
    recordBusinessEvent("user_login", "token_error");
    requestLogger.error("Token generation failed during login", {
      error,
      userId: existingUser._id.toString(),
      email: maskedEmail,
    });
    return next(new HttpError("Logging in failed, please try again later.", 500));
  }

  recordAuthEvent("login", "success");
  recordBusinessEvent("user_login", "success");
  requestLogger.info("User logged in", {
    userId: existingUser._id.toString(),
    email: maskedEmail,
  });

  res.json({
    userId: existingUser._id,
    email: existingUser.email,
    name: existingUser.name,
    image: existingUser.image,
    token,
  });
};

export { getUsers, signup, login };
