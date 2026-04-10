import { randomUUID } from "crypto";
import logger from "../util/logger.js";

const requestLogger = logger.child({ component: "request" });

const slowRequestThresholdMs = Number(
  process.env.SLOW_REQUEST_THRESHOLD_MS || 1000,
);

const ignoredAccessLogPaths = new Set([
  "/metrics",
  "/health/live",
  "/health/ready",
  "/favicon.ico",
  "/robots.txt",
]);

const sanitizePath = (inputPath = "unknown") =>
  inputPath
    .split("?")[0]
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      ":uuid",
    )
    .replace(/\b[0-9a-fA-F]{24}\b/g, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:number");

const getRouteLabel = (req) => {
  if (typeof req.route?.path === "string") {
    return `${req.baseUrl || ""}${req.route.path}`;
  }

  if (Array.isArray(req.route?.path)) {
    return `${req.baseUrl || ""}${req.route.path.join("|")}`;
  }

  return sanitizePath(req.originalUrl || req.path || "unknown");
};

const attachRequestContext = (req, res, next) => {
  const incomingRequestId = req.get("x-request-id");
  const requestId =
    typeof incomingRequestId === "string" && incomingRequestId.trim().length > 0
      ? incomingRequestId.trim()
      : randomUUID();

  req.requestId = requestId;
  req.logger = logger.child({ requestId });
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  next();
};

const requestLoggingMiddleware = (req, res, next) => {
  const startTime = process.hrtime.bigint();
  const activeLogger = req.logger?.child({ component: "request" }) || requestLogger;
  let logged = false;

  const logRequest = (statusCode, outcome) => {
    if (logged) {
      return;
    }
    logged = true;

    if (
      ignoredAccessLogPaths.has(req.path) &&
      statusCode < 400 &&
      outcome === "completed"
    ) {
      return;
    }

    const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
    const context = {
      method: req.method,
      route: getRouteLabel(req),
      path: sanitizePath(req.originalUrl || req.path || "unknown"),
      statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      contentLength: res.getHeader("content-length"),
      ip: req.ip,
      userAgent: req.get("user-agent"),
      userId: req.userData?.userId,
      outcome,
    };

    const logMethod =
      statusCode >= 500
        ? "error"
        : statusCode >= 400 || durationMs >= slowRequestThresholdMs
          ? "warn"
          : "info";

    activeLogger[logMethod]("Request completed", context);
  };

  res.on("finish", () => logRequest(res.statusCode, "completed"));
  res.on("close", () => {
    if (!res.writableFinished) {
      logRequest(499, "aborted");
    }
  });

  next();
};

export { attachRequestContext, getRouteLabel, requestLoggingMiddleware, sanitizePath };
