import { createClient } from 'redis';

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Main connection: table data, locks, timers, and the Socket.IO adapter's publishes.
 * Using one connection for all of these keeps their order: a broadcast sent while holding
 * a table's lock always reaches Redis before that lock is released.
 */
export const redis = createClient({ url });
/** Subscriber connection for the Socket.IO adapter (a subscribed connection can't run other commands). */
export const redisSub = redis.duplicate();

for (const [name, client] of [['main', redis], ['sub', redisSub]] as const) {
  client.on('error', (err) => console.error(`[poker] redis ${name} error:`, err.message));
}

export async function connectRedis(): Promise<void> {
  await Promise.all([redis.connect(), redisSub.connect()]);
}
