import type { Card } from './cards';
import type { Variant } from './variants';
import type { RoomSettings, RoomState } from './state';

/** A player's intent for their turn. For bet/raise, `amount` is the TOTAL "to" amount. */
export type PlayerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'bet'; amount: number }
  | { type: 'raise'; amount: number };

export interface CreateRoomAck {
  ok: true;
  roomId: string;
  playerId: string;
  token: string;
}

export type JoinRoomAck =
  | { ok: true; status: 'seated' | 'pending'; playerId: string; token: string }
  | { ok: false; error: string };

export type RejoinAck =
  | { ok: true; playerId: string; status: 'seated' | 'pending'; token: string }
  | { ok: false; error: string };

export interface ClientToServerEvents {
  createRoom: (data: { name: string; settings: RoomSettings }, cb: (ack: CreateRoomAck) => void) => void;
  joinRoom: (data: { roomId: string; name: string; buyIn?: number }, cb: (ack: JoinRoomAck) => void) => void;
  rejoin: (data: { roomId: string; token: string }, cb: (ack: RejoinAck) => void) => void;

  startHand: () => void;
  playerAction: (action: PlayerAction) => void;
  /** At a manual-select showdown, lock in which hole cards to use (by index). */
  selectCards: (indices: number[]) => void;
  /** Bomb Omaha: lock in which hole cards to use on each board (`a` = Board A, `b` = Board B). */
  selectBombCards: (data: { a: number[]; b: number[] }) => void;
  /** Crazy Pineapple: discard one hole card (by index) after the flop. */
  discardCard: (index: number) => void;
  /** After a hand, voluntarily reveal hole cards by index (e.g. [0,1] for both). */
  showCards: (indices: number[]) => void;
  sitOut: () => void;
  sitIn: () => void;
  leaveRoom: () => void;

  // Host-only controls (server re-checks authorization).
  hostApproveJoin: (requestId: string) => void;
  hostRejectJoin: (requestId: string) => void;
  hostAdjustStack: (data: { playerId: string; delta: number }) => void;
  hostSetStack: (data: { playerId: string; value: number }) => void;
  hostRemovePlayer: (playerId: string) => void;
  /** Force a manual-select showdown to resolve (auto-picks best for anyone who hasn't chosen). */
  hostForceShowdown: () => void;
  /** Choose the variant for the next hand (only allowed between hands). */
  hostSetVariant: (variant: Variant) => void;
  /** Number (Triple 9): after picking the variant, the dealer sets this hand's target (0-999) — locks it in and deals. */
  hostSetTripleNineNumber: (n: number) => void;
  /** Randomize seat assignments before the first hand. */
  hostShuffleSeats: () => void;
  /** Toggle/configure auto-dealing the next hand after a hand ends. */
  hostSetAutoStart: (data: { enabled: boolean; seconds: number }) => void;
  /** Toggle/configure auto-picking the variant if the dealer doesn't choose in time. */
  hostSetAutoPick: (data: { enabled: boolean; seconds: number }) => void;
}

export interface ServerToClientEvents {
  roomState: (state: RoomState) => void;
  /** Private hole cards for the recipient (also embedded in RoomState, sent for convenience). */
  yourCards: (cards: Card[]) => void;
  errorMsg: (message: string) => void;
  /** Sent on connect: which of the load-balanced servers this connection landed on. */
  serverInfo: (info: { serverId: string }) => void;
}
