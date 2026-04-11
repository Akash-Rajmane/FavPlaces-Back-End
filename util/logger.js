import fs from "fs";
import os from "os";
import path from "path";
import util from "util";
import winston from "winston";
import LokiTransport from "winston-loki";
import { fileURLToPath, URL } from "url";
import prometheusConfig from "./prometheus-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const logsDir = path.join(__dirname, "../logs");

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const SERVICE_NAME = prometheusConfig.appName || "favplaces-server";
const ENVIRONMENT = prometheusConfig.environment || "development";

const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const configuredLevel = (
  prometheusConfig.logLevel || (process.env.NODE_ENV === "production" ? "info" : "debug")
).toLowerCase();

const activeLogLevel = Object.prototype.hasOwnProperty.call(
  logLevels,
  configuredLevel,
)
  ? configuredLevel
  : "info";

const streams = {
  all: fs.createWriteStream(path.join(logsDir, "all.log"), { flags: "a" }),
  error: fs.createWriteStream(path.join(logsDir, "error.log"), { flags: "a" }),
  warn: fs.createWriteStream(path.join(logsDir, "warn.log"), { flags: "a" }),
  info: fs.createWriteStream(path.join(logsDir, "info.log"), { flags: "a" }),
  debug: fs.createWriteStream(path.join(logsDir, "debug.log"), { flags: "a" }),
};

const shouldLogToConsole =
  process.env.NODE_ENV !== "production" ||
  process.env.LOG_TO_CONSOLE === "true";

const formatConsoleMessage = ({ timestamp, level, message, ...meta }) => {
  const printableMeta = Object.fromEntries(Object.entries(meta));
  const context = Object.keys(printableMeta).length
    ? ` ${util.inspect(printableMeta, {
        depth: 6,
        colors: Boolean(process.stdout?.isTTY),
        breakLength: 120,
      })}`
    : "";
  return `[${level}] ${timestamp} ${message}${context}`;
};

const consoleFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.colorize({ all: true }),
  winston.format.printf(formatConsoleMessage),
);

const buildLokiHost = () => {
  const rawHost = prometheusConfig.lokiConfig.host?.trim();
  if (!rawHost) {
    return null;
  }

  const hasScheme = /^https?:\/\//i.test(rawHost);
  const baseHost = hasScheme ? rawHost : `http://${rawHost}`;

  try {
    const parsed = new URL(baseHost);
    if (prometheusConfig.lokiConfig.port) {
      parsed.port = String(prometheusConfig.lokiConfig.port);
    }

    return parsed.origin;
  } catch (error) {
    console.warn("Invalid Loki host", error);
    return null;
  }
};

const getLokiBasicAuth = () => {
  if (process.env.LOKI_BASIC_AUTH) {
    return process.env.LOKI_BASIC_AUTH;
  }

  const username = process.env.LOKI_USERNAME;
  const password = process.env.LOKI_PASSWORD;

  if (username && password) {
    return `${username}:${password}`;
  }

  return null;
};

const createLokiTransport = () => {
  if (!prometheusConfig.lokiConfig.enabled) {
    return null;
  }

  const host = buildLokiHost();
  if (!host) {
    return null;
  }

  const transportOptions = {
    host,
    json: true,
    batching: false,
    clearOnError: true,
    labels: {
      service: SERVICE_NAME,
      environment: ENVIRONMENT,
    },
    onConnectionError: (error) => {
      process.stderr.write(
        `[WARN] ${new Date().toISOString()} Loki transport error: ${error.message}\n`,
      );
    },
    timeout: Number(process.env.LOKI_TIMEOUT_MS || 10_000),
  };

  const basicAuth = getLokiBasicAuth();
  if (basicAuth) {
    transportOptions.basicAuth = basicAuth;
  }

  return new LokiTransport(transportOptions);
};

const winstonTransports = [];

if (shouldLogToConsole) {
  winstonTransports.push(
    new winston.transports.Console({
      level: activeLogLevel,
      format: consoleFormat,
    }),
  );
}

const lokiTransport = createLokiTransport();
if (lokiTransport) {
  winstonTransports.push(lokiTransport);
}

const winstonLogger =
  winstonTransports.length > 0
    ? winston.createLogger({
        level: activeLogLevel,
        defaultMeta: {
          service: SERVICE_NAME,
          environment: ENVIRONMENT,
          hostname: os.hostname(),
          pid: process.pid,
        },
        transports: winstonTransports,
      })
    : null;

const serializeError = (error) => {
  if (!(error instanceof Error)) {
    return error;
  }

  const serialized = {
    name: error.name,
    message: error.message,
  };

  if (error.stack) {
    serialized.stack = error.stack;
  }

  if (error.code !== undefined) {
    serialized.code = error.code;
  }

  if (error.status !== undefined) {
    serialized.status = error.status;
  }

  if (error.details !== undefined) {
    serialized.details = error.details;
  }

  return serialized;
};

const createJsonReplacer = () => {
  const seen = new WeakSet();

  return (key, value) => {
    if (value instanceof Error) {
      return serializeError(value);
    }

    if (typeof value === "bigint") {
      return value.toString();
    }

    if (value instanceof Map) {
      return Object.fromEntries(value);
    }

    if (value instanceof Set) {
      return Array.from(value);
    }

    if (value && typeof value === "object") {
      if (seen.has(value)) {
        return "[Circular]";
      }

      seen.add(value);
    }

    return value;
  };
};

const shouldLog = (level) => logLevels[level] <= logLevels[activeLogLevel];

const writeLog = (level, message, context = {}) => {
  if (!shouldLog(level)) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    service: SERVICE_NAME,
    environment: ENVIRONMENT,
    hostname: os.hostname(),
    pid: process.pid,
    message,
    ...context,
  };

  const line = JSON.stringify(entry, createJsonReplacer());

  streams[level].write(line + "\n");
  streams.all.write(line + "\n");

  if (winstonLogger) {
    winstonLogger.log({
      level,
      message,
      ...context,
      timestamp: entry.timestamp,
    });
  }
};

const createLogger = (bindings = {}) => ({
  child: (extraBindings = {}) =>
    createLogger({
      ...bindings,
      ...extraBindings,
    }),
  error: (message, context = {}) =>
    writeLog("error", message, { ...bindings, ...context }),
  warn: (message, context = {}) =>
    writeLog("warn", message, { ...bindings, ...context }),
  info: (message, context = {}) =>
    writeLog("info", message, { ...bindings, ...context }),
  debug: (message, context = {}) =>
    writeLog("debug", message, { ...bindings, ...context }),
});

const maskEmail = (email) => {
  if (typeof email !== "string" || !email.includes("@")) {
    return "redacted";
  }

  const [localPart, domain] = email.split("@");
  const visibleLocal =
    localPart.length <= 2
      ? `${localPart.slice(0, 1)}***`
      : `${localPart.slice(0, 2)}***`;

  return `${visibleLocal}@${domain}`;
};

process.on("exit", () => {
  Object.values(streams).forEach((stream) => stream.end());
  winstonLogger?.close();
});

const logger = createLogger();

export { createLogger, serializeError, maskEmail };
export default logger;
