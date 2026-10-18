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

const googleLogin = async (req, res, next) => {
  const requestLogger = getRequestLogger(req);
  const { credential } = req.body;

  if (!credential) {
    return next(new HttpError("Missing Google credential token.", 400));
  }

  const { OAuth2Client } = await import("google-auth-library");
  const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID ||
      "384601241809-4t6enfmfhlq6jl7hlemu3lefd14ubdqs.apps.googleusercontent.com"
  );

  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience:
        process.env.GOOGLE_CLIENT_ID ||
        "384601241809-4t6enfmfhlq6jl7hlemu3lefd14ubdqs.apps.googleusercontent.com",
    });
    payload = ticket.getPayload();
  } catch (error) {
    recordAuthEvent("google_login", "token_invalid");
    requestLogger.error("Google ID token verification failed", { error: error.message });
    return next(new HttpError("Invalid Google credential token.", 401));
  }

  const { name, email, picture, sub: googleId } = payload;
  const maskedEmail = maskEmail(email);

  let user;
  try {
    user = await trackDatabaseOperation("findOne", "users", () =>
      User.findOne({ email }).lean({ virtuals: true })
    );
  } catch (error) {
    recordAuthEvent("google_login", "database_error");
    requestLogger.error("Database error looking up Google user", { error: error.message, email: maskedEmail });
    return next(new HttpError("Logging in failed, please try again later.", 500));
  }

  // If user does not exist yet, auto-create their account with Google profile info
  if (!user) {
    try {
      const randomPassword = await bcrypt.hash(googleId + (process.env.JWT_KEY || "secret"), 12);
      const newUser = new User({
        name: name || "Google User",
        email: email,
        image: picture || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80",
        password: randomPassword,
        places: [],
      });

      await trackDatabaseOperation("insert", "users", () => newUser.save());
      user = newUser.toObject({ virtuals: true });
      await deleteKeys(cacheKeys.publicUsers());
      recordBusinessEvent("user_signup", "google_success");
      requestLogger.info("New user registered via Google", { userId: user._id.toString(), email: maskedEmail });
    } catch (createError) {
      recordAuthEvent("google_login", "create_failed");
      requestLogger.error("Failed to auto-register user via Google", { error: createError.message });
      return next(new HttpError("Could not create user account with Google.", 500));
    }
  }

  // Issue standard FavPlaces JWT session
  let token;
  try {
    token = jwt.sign(
      { userId: user._id, email: user.email },
      `${process.env.JWT_KEY}`,
      { expiresIn: "1h" }
    );
  } catch (tokenErr) {
    recordAuthEvent("google_login", "token_error");
    return next(new HttpError("Token creation failed, please try again.", 500));
  }

  recordAuthEvent("google_login", "success");
  requestLogger.info("User authenticated via Google", { userId: user._id.toString(), email: maskedEmail });

  res.status(200).json({
    userId: user._id,
    email: user.email,
    name: user.name,
    image: user.image,
    token,
  });
};

export { getUsers, signup, login, googleLogin };
