import { randomUUID } from 'node:crypto';
import { customAlphabet } from 'nanoid';
import type { RoomSettings } from '@poker/shared';
import { Room } from './room';
import { redis } from '../redis';
import { serializeRoom, deserializeRoom } from './serialize';

// Lowercase, no ambiguous characters (no 0/o/1/l) so codes are easy to share verbally.
const genRoomId = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 6);

/** Abandoned tables expire from Redis after a day without changes. */
const ROOM_TTL_SECONDS = 24 * 60 * 60;
/** A lock auto-expires so a server that dies while holding it can't freeze the table. */
const LOCK_TTL_MS = 5000;
const LOCK_WAIT_MS = 3000;
/** Sorted set of pending auto-start / auto-pick deadlines: member "<roomId>:<kind>", score = due ms. */
export const TIMERS_KEY = 'timers';
export type TimerKind = 'autoStart' | 'autoPick';
const TIMER_KINDS: TimerKind[] = ['autoStart', 'autoPick'];

const roomKey = (id: string) => `room:${id}`;
const lockKey = (id: string) => `lock:room:${id}`;

// Delete the lock only if it's still ours (it may have expired and been taken by another server).
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function lock(id: string): Promise<string> {
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const ok = await redis.set(lockKey(id), token, { NX: true, PX: LOCK_TTL_MS });
    if (ok) return token;
    await sleep(10 + Math.random() * 20);
  }
  throw new Error(`timed out waiting for the lock on room ${id}`);
}

async function unlock(id: string, token: string): Promise<void> {
  await redis.eval(RELEASE_LOCK, { keys: [lockKey(id)], arguments: [token] });
}

/** Save the room and mirror its timer deadlines into the shared timer queue. */
async function save(room: Room): Promise<void> {
  const multi = redis.multi().set(roomKey(room.id), serializeRoom(room), { EX: ROOM_TTL_SECONDS });
  for (const kind of TIMER_KINDS) {
    const at = room[`${kind}At`];
    const member = `${room.id}:${kind}`;
    if (at !== null) multi.zAdd(TIMERS_KEY, { score: at, value: member });
    else multi.zRem(TIMERS_KEY, member);
  }
  await multi.exec();
}

async function remove(id: string): Promise<void> {
  await redis
    .multi()
    .del(roomKey(id))
    .zRem(TIMERS_KEY, TIMER_KINDS.map((k) => `${id}:${k}`))
    .exec();
}

/**
 * Tables live in Redis, not in any one server's memory, so every server can serve every
 * table. Any change goes through `withRoom`, which holds that table's lock while it loads,
 * changes and saves it — so two servers can never change the same table at once.
 */
export const roomManager = {
  /** Create a new table; `setup` runs before the first save (e.g. to seat the host). */
  async create<T>(settings: RoomSettings, setup: (room: Room) => T): Promise<{ room: Room; result: T }> {
    for (;;) {
      const room = new Room(genRoomId(), settings);
      const result = setup(room);
      const ok = await redis.set(roomKey(room.id), serializeRoom(room), { NX: true, EX: ROOM_TTL_SECONDS });
      if (ok) return { room, result };
    }
  },

  /**
   * Lock the table, load it, run `fn`, then save it (or delete it once nobody is left).
   * Resolves to undefined when the table doesn't exist.
   */
  async withRoom<T>(rawId: string, fn: (room: Room) => T): Promise<{ room: Room; result: T } | undefined> {
    const id = rawId.toLowerCase();
    const token = await lock(id);
    try {
      const json = await redis.get(roomKey(id));
      if (!json) return undefined;
      const room = deserializeRoom(json);
      const result = fn(room);
      if (room.isEmpty()) await remove(id);
      else await save(room);
      return { room, result };
    } finally {
      await unlock(id, token);
    }
  },
};
