import { createClient } from "redis";
import logger from "./logger.js";

const cacheLogger = logger.child({ component: "redis-cache" });

const redisUrl =
  process.env.REDIS_URL ||
  (process.env.REDIS_HOST
    ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`
    : null);

const redisEnabled =
  process.env.REDIS_ENABLED !== "false" && Boolean(redisUrl);

let client = null;
let connectPromise = null;
let redisDisabledLogged = false;

const ensureClient = () => {
  if (!redisEnabled) {
    if (!redisDisabledLogged) {
      cacheLogger.info("Redis caching is disabled because no Redis connection is configured");
      redisDisabledLogged = true;
    }

    return null;
  }

  if (!client) {
    client = createClient({ url: redisUrl });
    client.on("error", (error) => {
      cacheLogger.error("Redis client error", { error });
    });
    client.on("ready", () => {
      cacheLogger.info("Redis client is ready");
    });
    client.on("reconnecting", () => {
      cacheLogger.warn("Redis client reconnecting");
    });
  }

  return client;
};

const getClient = async () => {
  const redisClient = ensureClient();

  if (!redisClient) {
    return null;
  }

  if (redisClient.isOpen) {
    return redisClient;
  }

  if (!connectPromise) {
    connectPromise = redisClient.connect().finally(() => {
      connectPromise = null;
    });
  }

  try {
    await connectPromise;
    return redisClient;
  } catch (error) {
    cacheLogger.error("Connecting to Redis failed", { error });
    return null;
  }
};

const safeJsonParse = (value, key) => {
  try {
    return JSON.parse(value);
  } catch (error) {
    cacheLogger.warn("Failed to parse cached JSON value", { key, error });
    return null;
  }
};

const getJson = async (key) => {
  const redisClient = await getClient();
  if (!redisClient) {
    return null;
  }

  try {
    const cachedValue = await redisClient.get(key);
    if (!cachedValue) {
      return null;
    }

    return safeJsonParse(cachedValue, key);
  } catch (error) {
    cacheLogger.error("Redis get failed", { key, error });
    return null;
  }
};

const setJson = async (key, value, ttlSeconds = 60) => {
  const redisClient = await getClient();
  if (!redisClient) {
    return false;
  }

  try {
    await redisClient.set(key, JSON.stringify(value), {
      EX: ttlSeconds,
    });
    return true;
  } catch (error) {
    cacheLogger.error("Redis set failed", { key, ttlSeconds, error });
    return false;
  }
};

const deleteKeys = async (...keys) => {
  const sanitizedKeys = keys.flat().filter(Boolean);
  if (!sanitizedKeys.length) {
    return 0;
  }

  const redisClient = await getClient();
  if (!redisClient) {
    return 0;
  }

  try {
    return await redisClient.del(sanitizedKeys);
  } catch (error) {
    cacheLogger.error("Redis delete failed", { keys: sanitizedKeys, error });
    return 0;
  }
};

const remember = async (key, ttlSeconds, loader) => {
  const cachedValue = await getJson(key);
  if (cachedValue !== null) {
    return { value: cachedValue, cacheHit: true };
  }

  const freshValue = await loader();
  await setJson(key, freshValue, ttlSeconds);

  return { value: freshValue, cacheHit: false };
};

const disconnectCache = async () => {
  if (!client?.isOpen) {
    return;
  }

  try {
    await client.quit();
  } catch (error) {
    cacheLogger.warn("Gracefully disconnecting Redis failed", { error });
  }
};

export { deleteKeys, disconnectCache, getJson, remember, setJson };
