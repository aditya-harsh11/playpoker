import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  RoomSettings,
  Variant,
} from '@poker/shared';
import { VARIANTS } from '@poker/shared';
import { roomManager, TIMERS_KEY, type TimerKind } from '../rooms/roomManager';
import { redis } from '../redis';
import type { Room } from '../rooms/room';

export interface SocketData {
  roomId?: string;
  playerId?: string;
}

type IO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

// ---- validation ------------------------------------------------------------

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fold') }),
  z.object({ type: z.literal('check') }),
  z.object({ type: z.literal('call') }),
  z.object({ type: z.literal('bet'), amount: z.number().finite() }),
  z.object({ type: z.literal('raise'), amount: z.number().finite() }),
]);

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

function clampSettings(s: unknown): RoomSettings {
  const obj = (s ?? {}) as Record<string, unknown>;
  const variant: Variant =
    typeof obj.variant === 'string' && obj.variant in VARIANTS ? (obj.variant as Variant) : 'texas';
  const bigBlind = clampInt(obj.bigBlind, 2, 1, 1_000_000);
  const smallBlind = clampInt(obj.smallBlind, Math.max(1, Math.floor(bigBlind / 2)), 1, bigBlind);
  const startingStack = clampInt(obj.startingStack, 1000, bigBlind, 100_000_000);
  const maxSeats = clampInt(obj.maxSeats, 8, 2, 8);
  return { variant, smallBlind, bigBlind, startingStack, maxSeats };
}

function cleanName(name: unknown): string {
  return String(name ?? '').trim().slice(0, 20) || 'Player';
}

// ---- broadcast -------------------------------------------------------------

function broadcast(io: IO, room: Room): void {
  for (const { socketId, viewerId } of room.audience()) {
    io.to(socketId).emit('roomState', room.snapshotFor(viewerId));
  }
}

function pushHoleCards(io: IO, room: Room): void {
  for (const player of room.players.values()) {
    if (player.socketId && player.inHand && player.holeCards.length) {
      io.to(player.socketId).emit('yourCards', player.holeCards);
    }
  }
}

// ---- registration ----------------------------------------------------------

const SERVER_ID = process.env.SERVER_ID ?? 'server';

export function registerHandlers(io: IO): void {
  io.on('connection', (socket: Sock) => {
    socket.emit('serverInfo', { serverId: SERVER_ID });

    const requireHost = (room: Room): boolean =>
      !!socket.data.playerId && room.isHost(socket.data.playerId);

    /**
     * Load this socket's table (under its lock), run `fn`, save it. Skipped when the socket
     * isn't at a table yet.
     */
    const withCurrentRoom = (fn: (room: Room, playerId: string) => void): Promise<unknown> => {
      const { roomId, playerId } = socket.data;
      if (!roomId || !playerId) return Promise.resolve();
      return roomManager.withRoom(roomId, (room) => fn(room, playerId));
    };

    // Wrap a listener so it can never crash the process: a throw (or a rejected promise) in
    // any handler is logged and reported to that one client instead of taking the server down.
    const register = socket.on.bind(socket) as (event: string, fn: (...a: unknown[]) => void) => void;
    const safe = (event: string, handler: (...a: unknown[]) => unknown): void => {
      register(event, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (err) {
          console.error(`[poker] handler "${event}" threw:`, err);
          try {
            socket.emit('errorMsg', 'Something went wrong — try again.');
          } catch {
            /* ignore secondary failures */
          }
        }
      });
    };
    const on = <E extends keyof ClientToServerEvents>(
      event: E,
      handler: (...args: Parameters<ClientToServerEvents[E]>) => unknown,
    ): void => safe(event as string, handler as (...a: unknown[]) => unknown);

    on('createRoom', async (data, cb) => {
      const settings = clampSettings(data?.settings);
      const { room, result: host } = await roomManager.create(settings, (r) =>
        r.addHost(cleanName(data?.name), socket.id),
      );
      socket.data.roomId = room.id;
      socket.data.playerId = host.id;
      socket.join(room.id);
      cb({ ok: true, roomId: room.id, playerId: host.id, token: host.token });
      broadcast(io, room);
    });

    on('joinRoom', async (data, cb) => {
      const found = await roomManager.withRoom(String(data?.roomId ?? ''), (room) => {
        if (!room.hasFreeSeat()) {
          cb({ ok: false, error: 'Table is full' });
          return;
        }
        const buyIn = clampInt(data?.buyIn, room.settings.startingStack, 1, 100_000_000);
        const req = room.requestJoin(cleanName(data?.name), buyIn, socket.id);
        socket.data.roomId = room.id;
        socket.data.playerId = req.requestId;
        socket.join(room.id);
        cb({ ok: true, status: 'pending', playerId: req.requestId, token: req.token });
        broadcast(io, room);
      });
      if (!found) cb({ ok: false, error: 'Room not found' });
    });

    on('rejoin', async (data, cb) => {
      const token = String(data?.token ?? '');
      const found = await roomManager.withRoom(String(data?.roomId ?? ''), (room) => {
        const seat = room.reassociate(token, socket.id);
        if (!seat) {
          cb({ ok: false, error: 'Session not found' });
          return;
        }
        socket.data.roomId = room.id;
        socket.data.playerId = seat.id;
        socket.join(room.id);
        cb({ ok: true, playerId: seat.id, status: seat.status, token });
        broadcast(io, room);
      });
      if (!found) cb({ ok: false, error: 'Room not found' });
    });

    on('startHand', () =>
      withCurrentRoom((room) => {
        if (!requireHost(room)) {
          socket.emit('errorMsg', 'Only the host can start the hand');
          return;
        }
        // The host doesn't deal directly anymore — they hand control to the dealer,
        // who then picks the variant which atomically triggers the actual deal.
        const res = room.startHand();
        if (!res.ok) {
          socket.emit('errorMsg', res.error ?? 'Could not start hand');
          return;
        }
        broadcast(io, room);
      }),
    );

    on('playerAction', (action) => {
      const parsed = actionSchema.safeParse(action);
      if (!parsed.success) {
        socket.emit('errorMsg', 'Invalid action');
        return;
      }
      return withCurrentRoom((room, playerId) => {
        const res = room.applyPlayerAction(playerId, parsed.data);
        if (!res.ok) {
          socket.emit('errorMsg', res.error ?? 'Illegal action');
          return;
        }
        broadcast(io, room);
      });
    });

    on('selectCards', (indices) => {
      const arr = Array.isArray(indices) ? indices.map(Number).filter((n) => Number.isFinite(n)) : [];
      return withCurrentRoom((room, playerId) => {
        room.selectCards(playerId, arr);
        broadcast(io, room);
      });
    });

    on('selectBombCards', (data) => {
      const toIdx = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : []);
      return withCurrentRoom((room, playerId) => {
        room.selectBombCards(playerId, toIdx(data?.a), toIdx(data?.b));
        broadcast(io, room);
      });
    });

    on('discardCard', (index) =>
      withCurrentRoom((room, playerId) => {
        room.discardCard(playerId, Number(index));
        broadcast(io, room);
      }),
    );

    on('showCards', (indices) => {
      const arr = Array.isArray(indices) ? indices.map(Number).filter((n) => Number.isFinite(n)) : [];
      return withCurrentRoom((room, playerId) => {
        room.showCards(playerId, arr);
        broadcast(io, room);
      });
    });

    on('sitOut', () =>
      withCurrentRoom((room, playerId) => {
        room.setSittingOut(playerId, true);
        broadcast(io, room);
      }),
    );

    on('sitIn', () =>
      withCurrentRoom((room, playerId) => {
        room.setSittingOut(playerId, false);
        broadcast(io, room);
      }),
    );

    on('leaveRoom', async () => {
      await withCurrentRoom((room, playerId) => {
        room.removePlayer(playerId);
        room.rejectJoin(playerId);
        socket.leave(room.id);
        // An empty table is deleted by the store when this returns.
        if (!room.isEmpty()) broadcast(io, room);
      });
      socket.data.roomId = undefined;
      socket.data.playerId = undefined;
    });

    // ---- host controls ----
    on('hostApproveJoin', (requestId) =>
      withCurrentRoom((room) => {
        if (!requireHost(room)) return;
        const player = room.approveJoin(String(requestId));
        if (player) broadcast(io, room);
      }),
    );

    on('hostRejectJoin', (requestId) =>
      withCurrentRoom((room) => {
        if (!requireHost(room)) return;
        const req = room.rejectJoin(String(requestId));
        if (req) {
          io.to(req.socketId).emit('errorMsg', 'The host declined your request to join');
          broadcast(io, room);
        }
      }),
    );

    on('hostAdjustStack', (data) =>
      withCurrentRoom((room) => {
        if (!requireHost(room)) return;
        room.adjustStack(String(data?.playerId), clampInt(data?.delta, 0, -100_000_000, 100_000_000));
        broadcast(io, room);
      }),
    );

    on('hostSetStack', (data) =>
      withCurrentRoom((room) => {
        if (!requireHost(room)) return;
        room.setStack(String(data?.playerId), clampInt(data?.value, 0, 0, 100_000_000));
        broadcast(io, room);
      }),
    );

    on('hostRemovePlayer', (playerId) =>
      withCurrentRoom((room) => {
        if (!requireHost(room)) return;
        const removed = room.removePlayer(String(playerId));
        if (removed?.socketId) {
          io.to(removed.socketId).emit('errorMsg', 'You were removed from the table by the host');
        }
        broadcast(io, room);
      }),
    );

    on('hostForceShowdown', () =>
      withCurrentRoom((room) => {
        if (!requireHost(room)) return;
        room.forceShowdown();
        broadcast(io, room);
      }),
    );

    on('hostSetVariant', (variant) =>
      withCurrentRoom((room, playerId) => {
        // Only the dealer-on-the-clock may pick — and picking atomically deals the
        // hand. The legacy "host fallback" was removed: hand 1 now also goes through
        // this same dealer-picks flow.
        const res = room.setVariantAndDeal(playerId, String(variant));
        if (!res.ok) {
          socket.emit('errorMsg', res.error ?? 'Could not pick the game');
          return;
        }
        pushHoleCards(io, room);
        broadcast(io, room);
      }),
    );

    on('hostSetTripleNineNumber', (n) =>
      withCurrentRoom((room, playerId) => {
        const res = room.setTripleNineTargetAndDeal(playerId, Number(n));
        if (!res.ok) {
          socket.emit('errorMsg', res.error ?? 'Could not set the number');
          return;
        }
        pushHoleCards(io, room);
        broadcast(io, room);
      }),
    );

    on('hostShuffleSeats', () =>
      withCurrentRoom((room) => {
        if (!requireHost(room)) return;
        if (room.shuffleSeats()) broadcast(io, room);
      }),
    );

    on('hostSetAutoStart', (data) =>
      withCurrentRoom((room) => {
        if (!requireHost(room)) return;
        const enabled = !!data?.enabled;
        const seconds = clampInt(data?.seconds, 5, 3, 60);
        room.setAutoStart(enabled, seconds);
        broadcast(io, room);
      }),
    );

    on('hostSetAutoPick', (data) =>
      withCurrentRoom((room) => {
        if (!requireHost(room)) return;
        const enabled = !!data?.enabled;
        const seconds = clampInt(data?.seconds, 5, 3, 60);
        room.setAutoPick(enabled, seconds);
        broadcast(io, room);
      }),
    );

    safe('disconnect', () =>
      withCurrentRoom((room, playerId) => {
        const player = room.getPlayer(playerId);
        // Only clear the seat's connection if it's still this socket — the player may
        // already have reconnected through another server.
        if (player) {
          if (player.socketId === socket.id) player.socketId = null; // keep their seat; they can rejoin with their token
        } else if (room.pending.get(playerId)?.socketId === socket.id) {
          room.rejectJoin(playerId); // drop an un-approved pending request
        }
        // An empty table is deleted by the store when this returns.
        if (!room.isEmpty()) broadcast(io, room);
      }),
    );
  });
}

// ---- shared timers -----------------------------------------------------------

const TIMER_POLL_MS = 500;

/**
 * Auto-start / auto-pick deadlines live in a Redis sorted set (not in a server's memory),
 * so they survive any one server dying. Every server polls it; removing a due entry is
 * atomic, so exactly one server wins it and runs that timer under the table's lock.
 */
export function startTimerPoller(io: IO): void {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const due = await redis.zRangeByScore(TIMERS_KEY, 0, Date.now());
      for (const member of due) {
        if ((await redis.zRem(TIMERS_KEY, member)) !== 1) continue; // another server took it
        const [roomId, kind] = member.split(':') as [string, TimerKind];
        await roomManager.withRoom(roomId, (room) => {
          const fired = kind === 'autoStart' ? room.fireAutoStart() : room.fireAutoPick();
          if (!fired) return;
          pushHoleCards(io, room); // a no-op when nothing was dealt (auto-start)
          broadcast(io, room);
        });
      }
    } catch (err) {
      console.error('[poker] timer poller error:', err);
    } finally {
      running = false;
    }
  }, TIMER_POLL_MS);
}
