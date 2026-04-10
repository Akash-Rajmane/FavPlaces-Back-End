import jwt from "jsonwebtoken";
import { recordAuthEvent } from "./metrics.js";
import logger from "../util/logger.js";

const optionalAuthLogger = logger.child({ component: "optional-auth" });

export default (req, res, next) => {
  if (req.method === "OPTIONS") {
    return next();
  }

  try {
    const requestLogger =
      req.logger?.child({ component: "optional-auth" }) || optionalAuthLogger;
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return next();
    }

    const [scheme, token] = authHeader.split(" ");
    if (scheme !== "Bearer" || !token) {
      recordAuthEvent("optional_token_validation", "malformed_token");
      requestLogger.debug("Ignoring malformed optional auth header");
      return next();
    }

    const decodedToken = jwt.verify(token, process.env.JWT_KEY);
    req.userData = { userId: decodedToken.userId };
    recordAuthEvent("optional_token_validation", "success");
  } catch (error) {
    const requestLogger =
      req.logger?.child({ component: "optional-auth" }) || optionalAuthLogger;
    recordAuthEvent("optional_token_validation", "invalid_token");
    requestLogger.debug("Ignoring invalid optional auth token", { error });
  }

  next();
};
