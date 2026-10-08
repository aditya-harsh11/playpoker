import { customAlphabet } from 'nanoid';
import type {
  Card,
  RoomSettings,
  RoomState,
  PublicPlayer,
  PublicGameState,
  JoinRequest,
  PlayerStatus,
  PlayerAction,
} from '@poker/shared';
import { VARIANTS, type Variant } from '@poker/shared';
import { PokerGame } from '../engine/pokerGame';

const genToken = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 20);
const genId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

/** Server-side player record (superset of PublicPlayer — holds secrets + bookkeeping). */
export interface ServerPlayer {
  id: string;
  token: string;
  name: string;
  seat: number;
  stack: number;
  status: PlayerStatus;
  committedThisRound: number;
  totalCommitted: number;
  inHand: boolean;
  holeCards: Card[];
  /** Hole-card indices this player has voluntarily shown after a hand. */
  shownCards: number[];
  /** Evaluated hand name at showdown (e.g. "Two Pair"). */
  handName?: string;
  lastAction?: string;
  socketId: string | null;
  totalBoughtIn: number;
  /** Times the host topped this player up after their initial buy-in. */
  rebuys: number;
  isHost: boolean;
}

interface PendingRequest {
  requestId: string;
  name: string;
  buyIn: number;
  socketId: string;
  token: string;
}

export class Room {
  readonly id: string;
  settings: RoomSettings;
  hostId: string;
  players = new Map<string, ServerPlayer>();
  pending = new Map<string, PendingRequest>();

  dealerButton = -1; // seat index of the dealer; -1 until first hand
  handNumber = 0;
  game: PokerGame | null = null;

  /**
   * Two-phase deal flow: the host clicks "Start hand", which moves the room into
   * `awaitingDealerPick = true` with `pendingDealerId` locked to whoever holds the
   * upcoming button. While this flag is true, only that dealer may call setVariant,
   * which both picks the variant AND immediately deals (one atomic transition).
   */
  awaitingDealerPick = false;
  pendingDealerId: string | null = null;

  /**
   * Number (Triple 9) only: once the dealer picks 'triple9', dealing pauses one more
   * beat for them to also lock in this hand's target number (0-999) — awaitingDealerPick
   * stays true throughout so the pending dealer stays locked and cancellation/auto-pick
   * keep working unchanged.
   */
  awaitingTripleNineTarget = false;
  private pendingTripleNineTarget: number | null = null;

  /**
   * Auto-start: when enabled, the room arms a timer the moment a hand ends and, when it
   * fires, auto-triggers `startHand()` (the dealer still picks the variant). Disabled by
   * default — the host toggles it via `setAutoStart`.
   */
  autoStart: { enabled: boolean; seconds: number } = { enabled: false, seconds: 5 };
  /** Epoch ms the auto-start fires at, or null. The Redis timer queue mirrors this. */
  autoStartAt: number | null = null;

  /**
   * Auto-pick: when enabled, if the on-the-clock dealer doesn't choose a variant within
   * `seconds`, the server picks the current/last variant for them and deals. Disabled by
   * default — the host toggles it via `setAutoPick`.
   */
  autoPick: { enabled: boolean; seconds: number } = { enabled: false, seconds: 5 };
  /** Epoch ms the auto-pick fires at, or null. The Redis timer queue mirrors this. */
  autoPickAt: number | null = null;

  constructor(id: string, settings: RoomSettings) {
    this.id = id;
    this.settings = settings;
    this.hostId = '';
  }

  // ---- lobby / membership -------------------------------------------------

  addHost(name: string, socketId: string): ServerPlayer {
    const host = this.makePlayer(name, this.settings.startingStack, socketId, true);
    this.hostId = host.id;
    return host;
  }

  private makePlayer(name: string, buyIn: number, socketId: string, isHost: boolean): ServerPlayer {
    const seat = this.firstFreeSeat();
    const player: ServerPlayer = {
      id: genId(),
      token: genToken(),
      name: name.slice(0, 20) || 'Player',
      seat,
      stack: buyIn,
      status: 'seated',
      committedThisRound: 0,
      totalCommitted: 0,
      inHand: false,
      holeCards: [],
      shownCards: [],
      socketId,
      totalBoughtIn: buyIn,
      rebuys: 0,
      isHost,
    };
    this.players.set(player.id, player);
    return player;
  }

  firstFreeSeat(): number {
    const taken = new Set([...this.players.values()].map((p) => p.seat));
    for (let s = 0; s < this.settings.maxSeats; s++) {
      if (!taken.has(s)) return s;
    }
    return -1;
  }

  hasFreeSeat(): boolean {
    return this.firstFreeSeat() !== -1;
  }

  requestJoin(name: string, buyIn: number, socketId: string): PendingRequest {
    const req: PendingRequest = {
      requestId: genId(),
      name: name.slice(0, 20) || 'Player',
      buyIn,
      socketId,
      token: genToken(),
    };
    this.pending.set(req.requestId, req);
    return req;
  }

  approveJoin(requestId: string): ServerPlayer | null {
    const req = this.pending.get(requestId);
    if (!req) return null;
    if (!this.hasFreeSeat()) return null;
    this.pending.delete(requestId);
    const seat = this.firstFreeSeat();
    const player: ServerPlayer = {
      id: req.requestId, // keep id stable so the pending socket's playerId still matches
      token: req.token,
      name: req.name,
      seat,
      stack: req.buyIn,
      status: 'seated',
      committedThisRound: 0,
      totalCommitted: 0,
      inHand: false,
      holeCards: [],
      shownCards: [],
      socketId: req.socketId,
      totalBoughtIn: req.buyIn,
      rebuys: 0,
      isHost: false,
    };
    this.players.set(player.id, player);
    return player;
  }

  rejectJoin(requestId: string): PendingRequest | null {
    const req = this.pending.get(requestId);
    if (!req) return null;
    this.pending.delete(requestId);
    return req;
  }

  removePlayer(playerId: string): ServerPlayer | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    // If they're in an active hand, fold them out first.
    if (this.game && player.inHand) {
      this.game.forceFold(playerId);
    }
    this.players.delete(playerId);
    // If the player who was on the clock to pick a variant just left, drop the
    // selection state so the host can re-trigger with whoever's now on the button.
    if (this.awaitingDealerPick && playerId === this.pendingDealerId) {
      this.cancelSelection();
    }
    return player;
  }

  setSittingOut(playerId: string, out: boolean): void {
    const p = this.players.get(playerId);
    if (!p) return;
    if (p.inHand) return; // can't change mid-hand; takes effect next hand
    p.status = out ? 'sittingout' : 'seated';
  }

  /**
   * Host chip tools (`adjustStack` / `setStack`) represent cash moving in or out of the
   * game, not gameplay results — actual wins/losses only ever move `stack` (inside
   * `PokerGame`, during a hand) and never touch `totalBoughtIn`. So any host-driven stack
   * change here moves `totalBoughtIn` by the same amount in both directions: buying a
   * player in raises both figures together (net unaffected), and undoing/correcting a
   * stack — e.g. a mistaken "+buy-in" set back down — lowers both together too, instead
   * of reading as a real loss (`netResult = stack - totalBoughtIn` would otherwise go
   * negative for a correction that was never actually lost at the table).
   */
  adjustStack(playerId: string, delta: number): void {
    const p = this.players.get(playerId);
    if (!p) return;
    const newStack = Math.max(0, p.stack + delta);
    const applied = newStack - p.stack;
    p.totalBoughtIn = Math.max(0, p.totalBoughtIn + applied);
    if (applied > 0) p.rebuys += 1;
    p.stack = newStack;
  }

  setStack(playerId: string, value: number): void {
    const p = this.players.get(playerId);
    if (!p) return;
    const v = Math.max(0, Math.floor(value));
    const delta = v - p.stack;
    p.totalBoughtIn = Math.max(0, p.totalBoughtIn + delta);
    if (delta > 0) p.rebuys += 1;
    p.stack = v;
  }

  /** Randomly reassign seats — only allowed before the very first hand. */
  shuffleSeats(): boolean {
    if (this.handNumber !== 0 || (this.game && !this.game.isComplete())) return false;
    const players = [...this.players.values()];
    const seats = Array.from({ length: this.settings.maxSeats }, (_, i) => i);
    for (let i = seats.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [seats[i], seats[j]] = [seats[j], seats[i]];
    }
    players.forEach((p, idx) => {
      p.seat = seats[idx];
    });
    return true;
  }

  /**
   * Dealer locks in the variant for the upcoming hand. Only valid while
   * `awaitingDealerPick` is true and only callable by the pending dealer. On success
   * this also immediately deals the hand — picking the variant IS the deal action —
   * except for Number (Triple 9), which needs one more input (the target) first.
   */
  setVariantAndDeal(playerId: string, variant: string): { ok: boolean; error?: string } {
    if (!this.awaitingDealerPick) return { ok: false, error: 'no variant selection in progress' };
    if (playerId !== this.pendingDealerId) return { ok: false, error: 'only the dealer can pick the game' };
    if (!(variant in VARIANTS)) return { ok: false, error: 'unknown variant' };
    this.settings = { ...this.settings, variant: variant as Variant };
    if (VARIANTS[variant as Variant].tripleNine) {
      this.awaitingTripleNineTarget = true;
      return { ok: true };
    }
    return this.dealHand();
  }

  /**
   * Number (Triple 9): the dealer locks in this hand's target (0-999) — the last input
   * needed before dealing. Only valid while `awaitingTripleNineTarget` is true and only
   * callable by the pending dealer.
   */
  setTripleNineTargetAndDeal(playerId: string, n: number): { ok: boolean; error?: string } {
    if (!this.awaitingTripleNineTarget) return { ok: false, error: 'no target number expected' };
    if (playerId !== this.pendingDealerId) return { ok: false, error: 'only the dealer can set the number' };
    if (!Number.isFinite(n)) return { ok: false, error: 'invalid number' };
    this.pendingTripleNineTarget = Math.max(0, Math.min(999, Math.floor(n)));
    this.awaitingTripleNineTarget = false;
    return this.dealHand();
  }

  /** Re-bind a reconnecting socket to an existing seat or pending request via its token. */
  reassociate(token: string, socketId: string): { id: string; status: 'seated' | 'pending' } | null {
    for (const p of this.players.values()) {
      if (p.token === token) {
        p.socketId = socketId;
        return { id: p.id, status: 'seated' };
      }
    }
    for (const r of this.pending.values()) {
      if (r.token === token) {
        r.socketId = socketId;
        return { id: r.requestId, status: 'pending' };
      }
    }
    return null;
  }

  // ---- game flow ----------------------------------------------------------

  /**
   * Host kicks off the next hand by entering the variant-selection state. We lock
   * in who the dealer for this hand will be (so subsequent join/leave can't shift
   * the picker out from under them) but do NOT advance the dealer button yet —
   * that happens atomically with the actual deal in `dealHand`.
   */
  beginSelection(): { ok: boolean; error?: string } {
    if (this.game && !this.game.isComplete()) {
      return { ok: false, error: 'a hand is already in progress' };
    }
    const participants = this.eligiblePlayers();
    if (participants.length < 2) {
      return { ok: false, error: 'need at least 2 players with chips' };
    }
    // A selection is starting (manually or via auto-start) — drop any pending countdown.
    this.clearAutoStartTimer();
    const dealerId = this.nextDealerId();
    if (!dealerId) return { ok: false, error: 'no eligible dealer' };
    this.pendingDealerId = dealerId;
    this.awaitingDealerPick = true;
    // Put the dealer on the clock if auto-pick is on.
    this.scheduleAutoPick();
    return { ok: true };
  }

  /** Public entrypoint the host hits — moves us into "dealer is picking the variant". */
  startHand(): { ok: boolean; error?: string } {
    return this.beginSelection();
  }

  /** Cancel an in-progress variant selection (host-only escape hatch). */
  cancelSelection(): void {
    this.awaitingDealerPick = false;
    this.pendingDealerId = null;
    this.awaitingTripleNineTarget = false;
    this.pendingTripleNineTarget = null;
    this.clearAutoPickTimer();
  }

  // ---- auto-start ---------------------------------------------------------

  /** Host enables/disables auto-start and sets the post-hand delay (clamped 3..60s). */
  setAutoStart(enabled: boolean, seconds: number): void {
    const secs = Math.max(3, Math.min(60, Math.floor(seconds) || 5));
    this.autoStart = { enabled, seconds: secs };
    if (!enabled) {
      this.clearAutoStartTimer();
    } else {
      // Re-arm the countdown with the new delay if we're sitting idle between hands.
      this.clearAutoStartTimer();
      this.scheduleAutoStart();
    }
  }

  private clearAutoStartTimer(): void {
    this.autoStartAt = null;
  }

  /**
   * Arm the auto-start countdown if conditions allow: feature on, nothing already armed,
   * no hand in progress, not mid-pick, and enough players. Safe to call repeatedly — it
   * no-ops while a countdown is already pending. Only sets the deadline; a server's timer
   * poller calls `fireAutoStart` once it passes.
   */
  private scheduleAutoStart(): void {
    if (!this.autoStart.enabled || this.autoStartAt !== null) return;
    if (this.handInProgress() || this.awaitingDealerPick) return;
    if (this.eligiblePlayers().length < 2) return;
    this.autoStartAt = Date.now() + this.autoStart.seconds * 1000;
  }

  /** Run the auto-start if its deadline has passed. Returns true if anything changed. */
  fireAutoStart(): boolean {
    if (this.autoStartAt === null || Date.now() < this.autoStartAt) return false;
    this.autoStartAt = null;
    if (!this.autoStart.enabled) return true;
    // Begins the dealer's-choice pick (same as the host clicking "Deal next hand").
    // If it can't start right now (e.g. players dropped below 2) it simply no-ops.
    this.startHand();
    return true;
  }

  // ---- auto-pick ----------------------------------------------------------

  /** Host enables/disables auto-pick and sets how long to wait on the dealer (3..60s). */
  setAutoPick(enabled: boolean, seconds: number): void {
    const secs = Math.max(3, Math.min(60, Math.floor(seconds) || 5));
    this.autoPick = { enabled, seconds: secs };
    this.clearAutoPickTimer();
    // If we're already waiting on a dealer, (re)arm the countdown with the new delay.
    if (enabled) this.scheduleAutoPick();
  }

  private clearAutoPickTimer(): void {
    this.autoPickAt = null;
  }

  /**
   * Arm the auto-pick countdown while a dealer is on the clock. When it fires, the server
   * deals a random variant on the dealer's behalf. No-ops unless we're actually awaiting a
   * pick and the feature is on. Only sets the deadline; a server's timer poller calls
   * `fireAutoPick` once it passes.
   */
  private scheduleAutoPick(): void {
    if (!this.autoPick.enabled || this.autoPickAt !== null) return;
    if (!this.awaitingDealerPick) return;
    this.autoPickAt = Date.now() + this.autoPick.seconds * 1000;
  }

  /** Run the auto-pick if its deadline has passed. Returns true if anything changed. */
  fireAutoPick(): boolean {
    if (this.autoPickAt === null || Date.now() < this.autoPickAt) return false;
    this.autoPickAt = null;
    if (!this.autoPick.enabled || !this.awaitingDealerPick) return true;
    // Pick a random variant on the dealer's behalf, then deal (dealHand reads settings.variant).
    // Bypasses any Triple 9 number the dealer may have been mid-entry on, same as it
    // bypasses every other in-progress human choice.
    const keys = Object.keys(VARIANTS) as Variant[];
    const choice = keys[Math.floor(Math.random() * keys.length)];
    this.settings = { ...this.settings, variant: choice };
    this.awaitingTripleNineTarget = false;
    if (VARIANTS[choice].tripleNine) {
      this.pendingTripleNineTarget = Math.floor(Math.random() * 1000);
    }
    this.dealHand();
    return true;
  }

  /**
   * Actually deal the hand. Advances the dealer button, increments the hand number,
   * wipes prior reveals and spins up a new PokerGame. Only called after the dealer
   * has locked in a variant via setVariantAndDeal.
   */
  private dealHand(): { ok: boolean; error?: string } {
    if (this.game && !this.game.isComplete()) {
      return { ok: false, error: 'a hand is already in progress' };
    }
    const participants = this.eligiblePlayers();
    if (participants.length < 2) {
      return { ok: false, error: 'need at least 2 players with chips' };
    }
    let buttonIdx: number;
    if (this.dealerButton < 0) {
      buttonIdx = 0;
    } else {
      buttonIdx = participants.findIndex((p) => p.seat > this.dealerButton);
      if (buttonIdx === -1) buttonIdx = 0;
    }
    this.dealerButton = participants[buttonIdx].seat;
    this.handNumber++;
    // Clear last hand's cards/reveals for everyone before dealing the new one.
    for (const p of this.players.values()) {
      p.holeCards = [];
      p.shownCards = [];
      p.handName = undefined;
    }
    const variantConfig = VARIANTS[this.settings.variant];
    this.game = new PokerGame(
      participants,
      { smallBlind: this.settings.smallBlind, bigBlind: this.settings.bigBlind },
      buttonIdx,
      this.handNumber,
      variantConfig,
      variantConfig.tripleNine ? (this.pendingTripleNineTarget ?? 0) : undefined,
    );
    this.awaitingDealerPick = false;
    this.pendingDealerId = null;
    this.awaitingTripleNineTarget = false;
    this.pendingTripleNineTarget = null;
    this.clearAutoPickTimer();
    this.maybeFinalize();
    return { ok: true };
  }

  /**
   * The player who will be on the button for the next hand — they pick the variant and
   * deal ("dealer's choice"). During an active variant selection we return the locked-in
   * pendingDealerId so subsequent join/leave can't shift the picker out from under them.
   */
  nextDealerId(): string | null {
    if (this.awaitingDealerPick && this.pendingDealerId) {
      // Sanity check: if the pinned dealer somehow left, fall through to recompute.
      if (this.players.has(this.pendingDealerId)) return this.pendingDealerId;
    }
    const participants = this.eligiblePlayers();
    if (participants.length < 2) return null;
    let idx: number;
    if (this.dealerButton < 0) {
      idx = 0;
    } else {
      idx = participants.findIndex((p) => p.seat > this.dealerButton);
      if (idx === -1) idx = 0;
    }
    return participants[idx].id;
  }

  /** Is there a hand currently being played (not waiting / not finished)? */
  handInProgress(): boolean {
    return !!this.game && !this.game.isComplete();
  }

  applyPlayerAction(playerId: string, action: PlayerAction): { ok: boolean; error?: string } {
    if (!this.game || this.game.isComplete()) return { ok: false, error: 'no active hand' };
    const res = this.game.applyAction(playerId, action);
    if (res.ok) this.maybeFinalize();
    return res;
  }

  /** A player locks in which hole cards to use at a manual-select showdown. */
  selectCards(playerId: string, indices: number[]): void {
    if (!this.game) return;
    this.game.submitSelection(playerId, indices);
    this.maybeFinalize();
  }

  /** Bomb Omaha: a player locks in their hole cards for each of the two boards. */
  selectBombCards(playerId: string, a: number[], b: number[]): void {
    if (!this.game) return;
    this.game.submitBombSelection(playerId, a, b);
    this.maybeFinalize();
  }

  /** Crazy Pineapple: a player discards one hole card after the flop. */
  discardCard(playerId: string, index: number): void {
    if (!this.game) return;
    this.game.submitDiscard(playerId, index);
    this.maybeFinalize();
  }

  /** Host forces the showdown to resolve (auto-picks best for anyone who hasn't chosen). */
  forceShowdown(): void {
    if (!this.game) return;
    this.game.forceResolve();
    this.maybeFinalize();
  }

  /**
   * When a hand ends, clear betting bookkeeping. EVERYONE who was dealt in keeps their hole
   * cards through the showdown window so they can optionally "Show" — even if they folded or
   * lost (e.g. to flash a bluff). Cards are wiped for everyone when the next hand starts.
   */
  private maybeFinalize(): void {
    if (!this.game || !this.game.isComplete()) return;
    for (const p of this.players.values()) {
      if (!p.inHand) continue;
      p.committedThisRound = 0;
      p.totalCommitted = 0;
      p.inHand = false;
      p.lastAction = undefined;
      if (p.status !== 'sittingout') p.status = 'seated';
    }
    // Hand's over — if auto-start is on, arm the countdown for the next deal.
    this.scheduleAutoStart();
  }

  /** A player voluntarily reveals some of their hole cards after a hand. */
  showCards(playerId: string, indices: number[]): void {
    if (!this.game || this.game.phase !== 'showdown') return;
    const p = this.players.get(playerId);
    if (!p || p.holeCards.length === 0) return;
    const valid = indices.filter((i) => Number.isInteger(i) && i >= 0 && i < p.holeCards.length);
    p.shownCards = [...new Set([...p.shownCards, ...valid])].sort();
  }

  isHost(playerId: string): boolean {
    return playerId === this.hostId;
  }

  getPlayer(playerId: string): ServerPlayer | undefined {
    return this.players.get(playerId);
  }

  /** Seated, chipped, not-sitting-out players eligible to be dealt into a hand. */
  eligiblePlayers(): ServerPlayer[] {
    return [...this.players.values()]
      .filter((p) => p.status !== 'sittingout' && p.stack > 0)
      .sort((a, b) => a.seat - b.seat);
  }

  isEmpty(): boolean {
    return this.players.size === 0 && this.pending.size === 0;
  }

  // ---- snapshots ----------------------------------------------------------

  private gameStateView(): PublicGameState {
    if (this.game) return this.game.publicState();
    return {
      phase: 'waiting',
      communityCards: [],
      communityCards2: [],
      tripleNineTarget: null,
      pots: [],
      totalPot: 0,
      currentBet: 0,
      minRaise: this.settings.bigBlind,
      toAct: null,
      awaitingSelection: false,
      awaitingDiscard: false,
      dealerSeat: this.dealerButton >= 0 ? this.dealerButton : null,
      smallBlindSeat: null,
      bigBlindSeat: null,
      smallBlind: this.settings.smallBlind,
      bigBlind: this.settings.bigBlind,
      handNumber: this.handNumber,
    };
  }

  private toPublicPlayer(p: ServerPlayer, viewerId: string): PublicPlayer {
    const phase = this.game?.phase;
    const active = phase === 'preflop' || phase === 'flop' || phase === 'turn' || phase === 'river';

    let visible: Card[] | undefined;
    let cardBacks = 0;
    if (p.id === viewerId) {
      // You always see your own cards.
      visible = p.holeCards.length ? p.holeCards : undefined;
    } else if (active) {
      // During play, others' live cards show as face-down backs.
      if (p.status !== 'folded') cardBacks = p.holeCards.length;
    } else {
      // Between hands / showdown: only the cards a player chose to show are visible.
      const shown = p.shownCards.filter((i) => i < p.holeCards.length).map((i) => p.holeCards[i]);
      visible = shown.length ? shown : undefined;
    }

    return {
      id: p.id,
      name: p.name,
      seat: p.seat,
      stack: p.stack,
      status: p.status,
      committedThisRound: p.committedThisRound,
      totalCommitted: p.totalCommitted,
      inHand: p.inHand,
      isDealer: p.seat === this.dealerButton,
      isConnected: p.socketId !== null,
      boughtIn: p.totalBoughtIn,
      netResult: p.stack - p.totalBoughtIn,
      rebuys: p.rebuys,
      lastAction: p.lastAction,
      holeCards: visible,
      cardBacks,
      shown: p.shownCards,
      hasSelected: this.game?.awaitingSelection ? this.game.hasSelected(p.id) : undefined,
      handName:
        p.id === viewerId || (p.holeCards.length > 0 && p.shownCards.length >= p.holeCards.length)
          ? p.handName
          : undefined,
    };
  }

  /** Build the redacted state for a given viewer (a seated player, host, or pending request). */
  snapshotFor(viewerId: string): RoomState {
    const players = [...this.players.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => this.toPublicPlayer(p, viewerId));

    const isPending = this.pending.has(viewerId);
    const isPlayer = this.players.has(viewerId);
    const youAreHost = viewerId === this.hostId;
    // Between hands, the upcoming dealer chooses the game and deals.
    const nextDealerId = this.handInProgress() ? null : this.nextDealerId();

    const state: RoomState = {
      roomId: this.id,
      hostId: this.hostId,
      settings: this.settings,
      players,
      game: this.gameStateView(),
      youId: viewerId,
      youAreHost,
      youStatus: youAreHost ? 'host' : isPlayer ? 'seated' : isPending ? 'pending' : 'spectator',
      nextDealerId,
      youAreDealer: !!nextDealerId && nextDealerId === viewerId,
      awaitingDealerPick: this.awaitingDealerPick,
      awaitingTripleNineTarget: this.awaitingTripleNineTarget,
      autoStart: this.autoStart,
      autoStartAt: this.autoStartAt,
      autoPick: this.autoPick,
      autoPickAt: this.autoPickAt,
      lastResult: this.game?.lastResult ?? undefined,
    };

    if (this.game) {
      if (this.game.awaitingSelection && this.game.isContender(viewerId) && !this.game.hasSelected(viewerId)) {
        state.youMustSelect = true;
      }
      if (this.game.mustDiscard(viewerId)) {
        state.youMustDiscard = true;
      }
      const sel = this.game.getSelection(viewerId);
      if (sel) state.yourSelection = sel;
      const note = this.game.notes.get(viewerId);
      if (note) state.youNote = note;
    }

    if (youAreHost) {
      const requests: JoinRequest[] = [...this.pending.values()].map((r) => ({
        requestId: r.requestId,
        name: r.name,
        buyIn: r.buyIn,
      }));
      state.joinRequests = requests;
    }

    if (this.game && isPlayer) {
      const actions = this.game.availableActionsFor(viewerId);
      if (actions) state.availableActions = actions;
    }

    return state;
  }

  /** Every socket id that should receive a snapshot, paired with its viewer id. */
  audience(): { socketId: string; viewerId: string }[] {
    const out: { socketId: string; viewerId: string }[] = [];
    for (const p of this.players.values()) {
      if (p.socketId) out.push({ socketId: p.socketId, viewerId: p.id });
    }
    for (const r of this.pending.values()) {
      out.push({ socketId: r.socketId, viewerId: r.requestId });
    }
    return out;
  }
}
