import { Room, type ServerPlayer } from './room';
import { PokerGame } from '../engine/pokerGame';
import { Deck } from '../engine/deck';

/**
 * Turn a Room (and its in-progress PokerGame) into a JSON string and back, so a table can
 * live in Redis and be picked up by any server. Maps and Sets are tagged so they survive
 * JSON; class prototypes are restored on load so methods work again.
 */

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return { __map: [...value.entries()] };
  if (value instanceof Set) return { __set: [...value.values()] };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object') {
    const v = value as { __map?: [unknown, unknown][]; __set?: unknown[] };
    if (v.__map) return new Map(v.__map);
    if (v.__set) return new Set(v.__set);
  }
  return value;
}

export function serializeRoom(room: Room): string {
  return JSON.stringify(room, replacer);
}

export function deserializeRoom(json: string): Room {
  const room = Object.setPrototypeOf(JSON.parse(json, reviver), Room.prototype) as Room;
  if (room.game) {
    const game = Object.setPrototypeOf(room.game, PokerGame.prototype) as PokerGame;
    const raw = game as unknown as { deck: Deck; seats: ServerPlayer[] };
    Object.setPrototypeOf(raw.deck, Deck.prototype);
    // The engine mutates the very same player objects the room holds, so point the
    // game's seats back at them. A player removed mid-hand keeps their saved copy.
    raw.seats = raw.seats.map((s) => room.players.get(s.id) ?? s);
  }
  return room;
}
