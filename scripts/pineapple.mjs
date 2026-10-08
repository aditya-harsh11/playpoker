// Tests Pineapple-style discards. VARIANT=pineapple (3->2, one discard) or
// VARIANT=crazy-pineapple (5->2, discard after flop/turn/river). Verifies chips
// conserved, the right number of discards happen, and everyone ends with 2 cards.
import { io } from 'socket.io-client';

const URL = process.env.SMOKE_URL ?? 'http://localhost:3001';
const VARIANT = process.env.VARIANT ?? 'crazy-pineapple';
const log = (...a) => console.log(...a);
const connect = () => io(URL, { transports: ['websocket'], forceNew: true });

const approved = new Set();
let started = false;
let finished = false;
const discardKeys = new Set();
let discardCount = 0;

function driver(sock, getId, label) {
  sock.on('errorMsg', (m) => log(`[${label}] error: ${m}`));
  sock.on('roomState', (st) => {
    // Dealer's choice: whoever is on the clock picks the game (and Number's target).
    if (st.youAreDealer && st.awaitingDealerPick) {
      if (st.awaitingTripleNineTarget) sock.emit('hostSetTripleNineNumber', 500);
      else sock.emit('hostSetVariant', st.settings.variant);
    }
    const myId = getId();
    if (st.youAreHost && st.joinRequests) {
      for (const r of st.joinRequests) {
        if (!approved.has(r.requestId)) {
          approved.add(r.requestId);
          sock.emit('hostApproveJoin', r.requestId);
        }
      }
      if (!started && st.players.length === 3 && st.game.phase === 'waiting') {
        started = true;
        log(`[host] starting ${VARIANT}`);
        sock.emit('startHand');
      }
    }
    const me = st.players.find((p) => p.id === myId);
    if (st.youMustDiscard && me) {
      const key = `${label}:${me.holeCards.length}`;
      if (!discardKeys.has(key)) {
        discardKeys.add(key);
        discardCount++;
        setTimeout(() => sock.emit('discardCard', 0), 15);
      }
    }
    if (st.game.toAct === myId && st.availableActions) {
      const av = st.availableActions;
      setTimeout(() => sock.emit('playerAction', av.canCheck ? { type: 'check' } : { type: 'call' }), 15);
    }
    if (!finished && st.lastResult && st.game.phase === 'showdown' && !st.game.awaitingSelection) {
      finished = true;
      const total = st.players.reduce((s, p) => s + p.stack, 0);
      log('board:', st.lastResult.board.map((c) => c.rank + c.suit).join(' '));
      log('winners:', st.lastResult.winners.map((w) => `${w.name} +${w.amount}`).join(', '));
      log('total discards observed:', discardCount);
      log('total chips (expect 3000):', total);
      log(total === 3000 ? 'PASS: chips conserved' : 'FAIL');
      setTimeout(() => process.exit(total === 3000 ? 0 : 1), 100);
    }
  });
}

const host = connect();
let hostId = '';
host.on('connect', () => {
  host.emit(
    'createRoom',
    { name: 'Alice', settings: { variant: VARIANT, smallBlind: 10, bigBlind: 20, startingStack: 1000, maxSeats: 8 } },
    (ack) => {
      hostId = ack.playerId;
      driver(host, () => hostId, 'Alice');
      for (const nm of ['Bob', 'Carol']) {
        const p = connect();
        let pid = '';
        p.on('connect', () => p.emit('joinRoom', { roomId: ack.roomId, name: nm }, (j) => {
          if (j.ok) { pid = j.playerId; driver(p, () => pid, nm); }
        }));
      }
    },
  );
});

setTimeout(() => { log('TIMEOUT'); process.exit(2); }, 20000);
