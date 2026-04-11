import dotenv from "dotenv";
import express from "express";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import path from "path";
import compression from "compression";
import { fileURLToPath } from "url";
import placesRoutes from "./routes/places-routes.js";
import usersRoutes from "./routes/users-routes.js";
import followRoutes from "./routes/follow-routes.js";
import pushRoutes from "./routes/push-routes.js";
import notificationsRoutes from "./routes/notifications-routes.js";
import HttpError from "./models/http-error.js";
import {
  metricsMiddleware,
  register,
  setApplicationReady,
  setMongoConnectionStatus,
} from "./middleware/metrics.js";
import {
  attachRequestContext,
  requestLoggingMiddleware,
} from "./middleware/request-context.js";
import logger from "./util/logger.js";
import prometheusConfig from "./util/prometheus-config.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appLogger = logger.child({ component: "app" });
const port = Number(process.env.PORT || 5000);

const app = express();

app.use(attachRequestContext);
app.use(metricsMiddleware);
app.use(requestLoggingMiddleware);
app.use(compression());
app.use(bodyParser.json());

process.on("unhandledRejection", (error) => {
  appLogger.error("Unhandled promise rejection", { error });
});

process.on("uncaughtException", (error) => {
  appLogger.error("Uncaught exception", { error });
});

mongoose.connection.on("connected", () => {
  setMongoConnectionStatus(true);
  appLogger.info("MongoDB connection established");
});

mongoose.connection.on("disconnected", () => {
  setMongoConnectionStatus(false);
  setApplicationReady(false);
  appLogger.warn("MongoDB connection disconnected");
});

mongoose.connection.on("error", (error) => {
  setMongoConnectionStatus(false);
  appLogger.error("MongoDB connection error", { error });
});

app.get("/favicon.ico", (req, res) => res.status(204).end());
app.get("/robots.txt", (req, res) => res.status(204).end());
app.get(prometheusConfig.liveHealthEndpoint, (req, res) => {
  res.status(200).json({
    status: "ok",
    service: prometheusConfig.appName,
    time: new Date().toISOString(),
  });
});
app.get(prometheusConfig.readinessEndpoint, (req, res) => {
  const isReady = mongoose.connection.readyState === 1;

  res.status(isReady ? 200 : 503).json({
    status: isReady ? "ready" : "degraded",
    database: isReady ? "connected" : "disconnected",
    time: new Date().toISOString(),
  });
});

app.use(
  "/uploads/images",
  express.static(path.join(__dirname, "uploads", "images")),
);

const allowedOrigins = [
  "http://localhost:3000",
  "https://favplaces.netlify.app",
  "https://fav-places.vercel.app",
];
app.use((req, res, next) => {
  const origin = req.headers.origin;

  const allowedOrigins = [
    "http://localhost:3000",
    "https://favplaces.netlify.app",
    "https://fav-places.vercel.app",
  ];

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  // 🔥 CRITICAL FIX: reflect exact requested headers
  const reqHeaders = req.headers["access-control-request-headers"];
  if (reqHeaders) {
    res.setHeader("Access-Control-Allow-Headers", reqHeaders);
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );

  // 🔥 MUST terminate preflight
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

app.get(prometheusConfig.metricsEndpoint, async (req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.send(await register.metrics());

    if (process.env.LOG_METRICS_ACCESS === "true") {
      req.logger?.debug("Metrics endpoint scraped");
    }
  } catch (error) {
    req.logger?.error("Failed to generate metrics", { error });
    res.status(500).json({ error: "Failed to generate metrics" });
  }
});

app.use("/api/places", placesRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/follow", followRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/notifications", notificationsRoutes);

app.use((req, res, next) => {
  return next(new HttpError("Could not find this route.", 404));
});

app.use((error, req, res, next) => {
  const statusCode =
    typeof error.code === "number" && error.code >= 100 && error.code < 600
      ? error.code
      : 500;

  req.logger?.error("Request failed", {
    error,
    method: req.method,
    path: req.originalUrl?.split("?")[0] || req.path,
    statusCode,
    userId: req.userData?.userId,
  });

  if (res.headerSent) {
    return next(error);
  }

  res.status(statusCode).json({
    message: error.message || "An unknown error occurred!",
  });
});

mongoose
  .connect(
    `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.j4rbbcm.mongodb.net/${process.env.DB_NAME}?retryWrites=true&w=majority`,
  )
  .then(() => {
    app.listen(port, () => {
      setApplicationReady(true);
      appLogger.info("Server started successfully", {
        port,
        environment: prometheusConfig.environment,
        metricsEndpoint: prometheusConfig.metricsEndpoint,
        readinessEndpoint: prometheusConfig.readinessEndpoint,
      });
    });
  })
  .catch((error) => {
    setApplicationReady(false);
    appLogger.error("Failed to start server or connect to MongoDB", { error });
    console.error(error);
  });
