const Redis = require("ioredis");

const redisUrl = process.env.REDIS_URL;

const redis = redisUrl
  ? new Redis(redisUrl)
  : new Redis({
      host: process.env.REDIS_HOST || "localhost",
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: 0,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      keepAlive: 30000,
    });

redis.on("connect", () => {
  console.log("✅ Connected to Redis");
});

redis.on("ready", () => {
  console.log("✅ Redis is ready");
});

redis.on("error", (err) => {
  console.error("❌ Redis connection error:", err.message);
});

redis.on("close", () => {
  console.log("🔌 Redis connection closed");
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await redis.quit();
});

module.exports = redis;
