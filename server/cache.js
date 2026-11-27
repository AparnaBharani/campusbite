export function createCache(redis) {
  return {
    async get(key) {
      const value = await redis.get(`campus-bite:${key}`);
      return value ? JSON.parse(value) : null;
    },
    async set(key, value, seconds) {
      await redis.set(`campus-bite:${key}`, JSON.stringify(value), { EX: seconds });
    },
    async deleteByPrefix(prefix) {
      for await (const key of redis.scanIterator({ MATCH: `campus-bite:${prefix}*`, COUNT: 100 })) {
        if (key.length) await redis.del(key);
      }
    },
  };
}
