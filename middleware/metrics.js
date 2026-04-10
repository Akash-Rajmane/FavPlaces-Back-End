import prometheus from "prom-client";
import { getRouteLabel } from "./request-context.js";

const register = new prometheus.Registry();
register.setDefaultLabels({
  service: "favplaces-server",
  environment: process.env.NODE_ENV || "development",
});

prometheus.collectDefaultMetrics({ register });

const httpRequestDuration = new prometheus.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

const httpRequestTotal = new prometheus.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

const httpErrorsTotal = new prometheus.Counter({
  name: "http_errors_total",
  help: "Total number of HTTP errors",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

const databaseOperationDuration = new prometheus.Histogram({
  name: "database_operation_duration_seconds",
  help: "Duration of database operations",
  labelNames: ["operation", "collection", "status"],
  registers: [register],
  buckets: [0.05, 0.1, 0.5, 1, 2, 5],
});

const databaseOperationsTotal = new prometheus.Counter({
  name: "database_operations_total",
  help: "Total number of database operations",
  labelNames: ["operation", "collection", "status"],
  registers: [register],
});

const activeConnections = new prometheus.Gauge({
  name: "active_connections",
  help: "Number of in-flight HTTP requests",
  registers: [register],
});

const externalApiDuration = new prometheus.Histogram({
  name: "external_api_duration_seconds",
  help: "Duration of external API calls",
  labelNames: ["service", "operation", "status"],
  registers: [register],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

const externalApiRequestsTotal = new prometheus.Counter({
  name: "external_api_requests_total",
  help: "Total number of external API calls",
  labelNames: ["service", "operation", "status"],
  registers: [register],
});

const authEventsTotal = new prometheus.Counter({
  name: "auth_events_total",
  help: "Authentication and authorization events",
  labelNames: ["action", "status"],
  registers: [register],
});

const businessEventsTotal = new prometheus.Counter({
  name: "business_events_total",
  help: "Application business events",
  labelNames: ["event", "status"],
  registers: [register],
});

const applicationReady = new prometheus.Gauge({
  name: "application_ready",
  help: "Whether the application is ready to serve traffic",
  registers: [register],
});

const mongodbConnectionStatus = new prometheus.Gauge({
  name: "mongodb_connection_status",
  help: "MongoDB connection status where 1 means connected and 0 means disconnected",
  registers: [register],
});

applicationReady.set(0);
mongodbConnectionStatus.set(0);

const ignoredMetricsPaths = new Set([
  "/metrics",
  "/health/live",
  "/health/ready",
  "/favicon.ico",
  "/robots.txt",
]);

const metricsMiddleware = (req, res, next) => {
  const shouldIgnore = ignoredMetricsPaths.has(req.path);
  const startTime = process.hrtime.bigint();
  let requestCompleted = false;

  if (!shouldIgnore) {
    activeConnections.inc();
  }

  const recordRequest = (statusCode) => {
    if (requestCompleted) {
      return;
    }
    requestCompleted = true;

    if (!shouldIgnore) {
      activeConnections.dec();
    }

    if (shouldIgnore) {
      return;
    }

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    const labels = {
      method: req.method,
      route: getRouteLabel(req),
      status_code: String(statusCode),
    };

    httpRequestDuration.observe(labels, duration);
    httpRequestTotal.inc(labels);

    if (statusCode >= 400) {
      httpErrorsTotal.inc(labels);
    }
  };

  res.on("finish", () => recordRequest(res.statusCode));
  res.on("close", () => {
    if (!res.writableFinished) {
      recordRequest(499);
    }
  });

  next();
};

const recordDatabaseOperation = (operation, collection, duration, status = "success") => {
  databaseOperationDuration
    .labels(operation, collection, status)
    .observe(duration / 1000);
  databaseOperationsTotal.labels(operation, collection, status).inc();
};

const trackDatabaseOperation = async (operation, collection, handler) => {
  const endTimer = databaseOperationDuration.startTimer({
    operation,
    collection,
  });

  try {
    const result = await handler();
    endTimer({ status: "success" });
    databaseOperationsTotal.inc({ operation, collection, status: "success" });
    return result;
  } catch (error) {
    endTimer({ status: "error" });
    databaseOperationsTotal.inc({ operation, collection, status: "error" });
    throw error;
  }
};

const recordExternalCall = (service, operation, duration, status = "success") => {
  externalApiDuration
    .labels(service, operation, status)
    .observe(duration / 1000);
  externalApiRequestsTotal.labels(service, operation, status).inc();
};

const trackExternalCall = async (service, operation, handler) => {
  const endTimer = externalApiDuration.startTimer({
    service,
    operation,
  });

  try {
    const result = await handler();
    endTimer({ status: "success" });
    externalApiRequestsTotal.inc({ service, operation, status: "success" });
    return result;
  } catch (error) {
    endTimer({ status: "error" });
    externalApiRequestsTotal.inc({ service, operation, status: "error" });
    throw error;
  }
};

const recordAuthEvent = (action, status = "success") => {
  authEventsTotal.inc({ action, status });
};

const recordBusinessEvent = (event, status = "success") => {
  businessEventsTotal.inc({ event, status });
};

const setApplicationReady = (isReady) => {
  applicationReady.set(isReady ? 1 : 0);
};

const setMongoConnectionStatus = (isConnected) => {
  mongodbConnectionStatus.set(isConnected ? 1 : 0);
};

export {
  register,
  metricsMiddleware,
  recordAuthEvent,
  recordBusinessEvent,
  recordDatabaseOperation,
  recordExternalCall,
  setApplicationReady,
  setMongoConnectionStatus,
  trackDatabaseOperation,
  trackExternalCall,
  httpRequestDuration,
  httpRequestTotal,
  httpErrorsTotal,
  databaseOperationDuration,
  databaseOperationsTotal,
  activeConnections,
  externalApiDuration,
  externalApiRequestsTotal,
  authEventsTotal,
  businessEventsTotal,
  applicationReady,
  mongodbConnectionStatus,
};
