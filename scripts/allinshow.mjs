// Verifies all-in players are auto-revealed at showdown (others can see their cards).
import { io } from 'socket.io-client';

const URL = process.env.SMOKE_URL ?? 'http://localhost:3001';
const log = (...a) => console.log(...a);
const connect = () => io(URL, { transports: ['websocket'], forceNew: true });

const approved = new Set();
let started = false;
let done = false;

function driver(sock, getId, label) {
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
        sock.emit('startHand');
      }
    }
    // Everyone jams all-in.
    if (st.game.toAct === myId && st.availableActions) {
      const av = st.availableActions;
      const a = av.canRaise
        ? { type: 'raise', amount: av.maxRaiseTo }
        : av.canBet
          ? { type: 'bet', amount: av.maxRaiseTo }
          : av.canCall
            ? { type: 'call' }
            : { type: 'check' };
      setTimeout(() => sock.emit('playerAction', a), 15);
    }
    // Host checks that every opponent's cards are visible at showdown.
    if (st.youAreHost && !done && st.game.phase === 'showdown' && !st.game.awaitingSelection && st.lastResult) {
      done = true;
      const others = st.players.filter((p) => p.id !== myId);
      const allVisible = others.every((p) => (p.holeCards?.length ?? 0) > 0);
      for (const p of others) {
        log(`${p.name}: cards=${(p.holeCards ?? []).map((c) => c.rank + c.suit).join(' ') || '(hidden)'}`);
      }
      log(allVisible ? 'PASS: all-in opponents revealed' : 'FAIL: some all-in cards hidden');
      setTimeout(() => process.exit(allVisible ? 0 : 1), 80);
    }
  });
}

const host = connect();
let hostId = '';
host.on('connect', () => {
  host.emit(
    'createRoom',
    { name: 'Alice', settings: { variant: 'texas', smallBlind: 10, bigBlind: 20, startingStack: 1000, maxSeats: 8 } },
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

setTimeout(() => { log('TIMEOUT'); process.exit(2); }, 12000);
