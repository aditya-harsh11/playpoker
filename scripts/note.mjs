// Drives a dirty-omaha hand where everyone selects just [0,1]; prints each player's
// private "could have made" note (should appear for whoever left a better hand on the table).
import { io } from 'socket.io-client';

const URL = process.env.SMOKE_URL ?? 'http://localhost:3001';
const log = (...a) => console.log(...a);
const connect = () => io(URL, { transports: ['websocket'], forceNew: true });

const approved = new Set();
let started = false;
const selected = new Set();
let reported = false;
const lastByName = {};

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
    if (st.youMustSelect && !selected.has(label)) {
      selected.add(label);
      setTimeout(() => sock.emit('selectCards', [0, 1]), 15);
    }
    lastByName[label] = st;
  });
}

const host = connect();
let hostId = '';
host.on('connect', () => {
  host.emit(
    'createRoom',
    { name: 'Alice', settings: { variant: 'dirty-omaha', smallBlind: 5, bigBlind: 10, startingStack: 1000, maxSeats: 8 } },
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

setTimeout(() => {
  if (reported) return;
  reported = true;
  for (const [name, st] of Object.entries(lastByName)) {
    const me = st.players.find((p) => p.id === st.youId);
    const won = (st.lastResult?.winners ?? []).some((w) => w.playerId === st.youId);
    log(`${name}: ${won ? 'WON' : 'lost'} | hand=${me?.handName ?? '-'} | note=${st.youNote ?? 'none'}`);
  }
  process.exit(0);
}, 6000);
