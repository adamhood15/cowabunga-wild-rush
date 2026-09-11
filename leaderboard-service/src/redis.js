const Redis = require("ioredis");

// Railway injects REDIS_URL automatically once the Redis add-on is
// attached to this service's project.
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});

module.exports = redis;
