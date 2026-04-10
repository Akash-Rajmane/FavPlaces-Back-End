import jwt from "jsonwebtoken";
import HttpError from "../models/http-error.js";
import { recordAuthEvent } from "./metrics.js";
import logger from "../util/logger.js";

const authLogger = logger.child({ component: "check-auth" });

export default (req, res, next) => {
  if (req.method === "OPTIONS") {
    return next();
  }

  const requestLogger =
    req.logger?.child({ component: "check-auth" }) || authLogger;
  let failureStatus = "invalid_token";

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      failureStatus = "missing_token";
      requestLogger.warn("Authorization header is missing");
      throw new Error("Authentication failed");
    }

    const [scheme, token] = authHeader.split(" ");
    if (scheme !== "Bearer" || !token) {
      failureStatus = "malformed_token";
      requestLogger.warn("Authorization header is malformed");
      throw new Error("Authentication failed");
    }

    const decodedToken = jwt.verify(token, `${process.env.JWT_KEY}`);
    req.userData = { userId: decodedToken.userId };
    recordAuthEvent("token_validation", "success");

    next();
  } catch (caughtError) {
    recordAuthEvent("token_validation", failureStatus);
    requestLogger.warn("Authentication failed", {
      status: failureStatus,
      error: failureStatus === "invalid_token" ? caughtError : undefined,
    });

    return next(new HttpError("Authentication failed", 403));
  }
};
