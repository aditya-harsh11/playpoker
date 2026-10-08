// End-to-end smoke test: drives the real Socket.IO server through a full hand.
// Usage: node scripts/smoke.mjs   (server must be running on :3001)
import { io } from 'socket.io-client';

const URL = process.env.SMOKE_URL ?? 'http://localhost:3001';
const log = (...a) => console.log(...a);

function connect() {
  return io(URL, { transports: ['websocket'], forceNew: true });
}

const approved = new Set();
let started = false;
let finished = false;

function driver(sock, getId, label) {
  sock.on('errorMsg', (m) => log(`[${label}] error: ${m}`));
  sock.on('roomState', (st) => {
    // Dealer's choice: whoever is on the clock picks the game (and Number's target).
    if (st.youAreDealer && st.awaitingDealerPick) {
      if (st.awaitingTripleNineTarget) sock.emit('hostSetTripleNineNumber', 500);
      else sock.emit('hostSetVariant', st.settings.variant);
    }
    const myId = getId();
    // Host: approve any pending join requests, then start once 3 are seated.
    if (st.youAreHost && st.joinRequests) {
      for (const r of st.joinRequests) {
        if (!approved.has(r.requestId)) {
          approved.add(r.requestId);
          sock.emit('hostApproveJoin', r.requestId);
        }
      }
      if (!started && st.players.length === 3 && st.game.phase === 'waiting') {
        started = true;
        log('[host] starting hand with', st.players.length, 'players');
        sock.emit('startHand');
      }
    }
    // Anyone whose turn it is acts: check if possible, else call.
    if (st.game.toAct === myId && st.availableActions) {
      const av = st.availableActions;
      const action = av.canCheck ? { type: 'check' } : av.canCall ? { type: 'call' } : { type: 'fold' };
      setTimeout(() => sock.emit('playerAction', action), 20);
    }
    // Detect completion.
    if (!finished && st.lastResult && st.game.phase === 'showdown') {
      finished = true;
      const total = st.players.reduce((s, p) => s + p.stack, 0);
      log('\n=== HAND COMPLETE ===');
      log('board:', st.lastResult.board.map((c) => c.rank + c.suit).join(' '));
      log('winners:', st.lastResult.winners.map((w) => `${w.name} +${w.amount}${w.handName ? ' (' + w.handName + ')' : ''}`).join(', '));
      log('final stacks:', st.players.map((p) => `${p.name}=${p.stack}`).join(', '));
      log('total chips (expect 3000):', total);
      log(total === 3000 ? 'PASS: chips conserved' : 'FAIL: chip mismatch');
      setTimeout(() => process.exit(total === 3000 ? 0 : 1), 100);
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
      log('[host] created room', ack.roomId);
      driver(host, () => hostId, 'host');

      // Two players join.
      for (const name of ['Bob', 'Carol']) {
        const p = connect();
        let pid = '';
        p.on('connect', () => {
          p.emit('joinRoom', { roomId: ack.roomId, name }, (jack) => {
            if (jack.ok) {
              pid = jack.playerId;
              log(`[${name}] joined (pending)`);
              driver(p, () => pid, name);
            } else {
              log(`[${name}] join failed: ${jack.error}`);
            }
          });
        });
      }
    },
  );
});

setTimeout(() => {
  log('TIMEOUT: hand did not complete');
  process.exit(2);
}, 15000);
