// Verifies that when a player shows their cards at showdown, others can see the
// evaluated hand name (e.g. "Two Pair").
import { io } from 'socket.io-client';

const URL = process.env.SMOKE_URL ?? 'http://localhost:3001';
const log = (...a) => console.log(...a);
const connect = () => io(URL, { transports: ['websocket'], forceNew: true });

const approved = new Set();
let started = false;
let shown = false;
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
    if (st.game.toAct === myId && st.availableActions) {
      const av = st.availableActions;
      setTimeout(() => sock.emit('playerAction', av.canCheck ? { type: 'check' } : { type: 'call' }), 15);
    }
    // Once at showdown, the player named Bob shows both cards.
    if (label === 'Bob' && !shown && st.game.phase === 'showdown' && !st.game.awaitingSelection) {
      const me = st.players.find((p) => p.id === myId);
      if (me && me.holeCards && me.holeCards.length) {
        shown = true;
        const idx = me.holeCards.map((_, i) => i);
        setTimeout(() => sock.emit('showCards', idx), 20);
      }
    }
    // Host checks Bob's hand name became visible.
    if (st.youAreHost && !done && shown) {
      const bob = st.players.find((p) => p.name === 'Bob');
      if (bob && bob.handName) {
        done = true;
        log('Bob shown cards:', (bob.holeCards ?? []).map((c) => c.rank + c.suit).join(' '));
        log('Bob hand name visible to host:', bob.handName);
        log('PASS');
        setTimeout(() => process.exit(0), 50);
      }
    }
  });
}

const host = connect();
let hostId = '';
host.on('connect', () => {
  host.emit(
    'createRoom',
    { name: 'Alice', settings: { variant: 'texas', smallBlind: 5, bigBlind: 10, startingStack: 1000, maxSeats: 8 } },
    (ack) => {
      hostId = ack.playerId;
      driver(host, () => hostId, 'Alice');
      for (const name of ['Bob', 'Carol']) {
        const p = connect();
        let pid = '';
        p.on('connect', () => {
          p.emit('joinRoom', { roomId: ack.roomId, name }, (jack) => {
            if (jack.ok) {
              pid = jack.playerId;
              driver(p, () => pid, name);
            }
          });
        });
      }
    },
  );
});

setTimeout(() => {
  log('TIMEOUT');
  process.exit(2);
}, 15000);
