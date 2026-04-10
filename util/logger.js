import fs from "fs";
import os from "os";
import path from "path";
import util from "util";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(__dirname, "../logs");

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const SERVICE_NAME = "favplaces-server";
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const configuredLevel =
  process.env.LOG_LEVEL?.toLowerCase() ||
  (process.env.NODE_ENV === "production" ? "info" : "debug");

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

const writeConsole = (level, message, context = {}) => {
  const shouldWriteToConsole =
    process.env.NODE_ENV !== "production" ||
    process.env.LOG_TO_CONSOLE === "true";

  if (!shouldWriteToConsole) {
    return;
  }

  const consoleMethod =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;

  const inspectedContext = Object.keys(context).length
    ? ` ${util.inspect(context, {
        depth: 6,
        colors: Boolean(process.stdout?.isTTY),
        breakLength: 120,
      })}`
    : "";

  consoleMethod(
    `[${level.toUpperCase()}] ${new Date().toISOString()} ${message}${inspectedContext}`,
  );
};

const writeLog = (level, message, context = {}) => {
  if (!shouldLog(level)) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    service: SERVICE_NAME,
    environment: process.env.NODE_ENV || "development",
    hostname: os.hostname(),
    pid: process.pid,
    message,
    ...context,
  };

  const line = JSON.stringify(entry, createJsonReplacer());

  streams[level].write(line + "\n");
  streams.all.write(line + "\n");
  writeConsole(level, message, context);
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
});

const logger = createLogger();

export { createLogger, logsDir, maskEmail, serializeError };
export default logger;
