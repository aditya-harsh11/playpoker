// End-to-end test of a manual-select variant: deal -> bet -> each contender selects
// their hole cards -> resolve. Verifies chips are conserved. Server must be running.
// Usage: VARIANT=dirty-omaha SMOKE_URL=http://localhost:3010 node scripts/variant.mjs
import { io } from 'socket.io-client';

const URL = process.env.SMOKE_URL ?? 'http://localhost:3001';
const VARIANT = process.env.VARIANT ?? 'dirty-omaha';
const log = (...a) => console.log(...a);
const connect = () => io(URL, { transports: ['websocket'], forceNew: true });

const approved = new Set();
let started = false;
let finished = false;
const selected = new Set(); // socket ids that have selected this hand

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
        log(`[host] starting ${VARIANT} hand`);
        sock.emit('startHand');
      }
    }

    // Betting: act when it's our turn.
    if (st.game.toAct === myId && st.availableActions) {
      const av = st.availableActions;
      const action = av.canCheck ? { type: 'check' } : av.canCall ? { type: 'call' } : { type: 'fold' };
      setTimeout(() => sock.emit('playerAction', action), 15);
    }

    // Manual-select showdown: pick a legal number of hole cards for this variant.
    if (st.youMustSelect && !selected.has(label)) {
      selected.add(label);
      const pick = VARIANT === 'one-three-five' ? [0] : [0, 1];
      log(`[${label}] selecting cards [${pick}]`);
      setTimeout(() => sock.emit('selectCards', pick), 15);
    }

    if (!finished && st.lastResult && st.game.phase === 'showdown' && !st.game.awaitingSelection) {
      finished = true;
      const total = st.players.reduce((s, p) => s + p.stack, 0);
      log('\n=== HAND COMPLETE ===');
      log('board:', st.lastResult.board.map((c) => c.rank + c.suit).join(' '));
      log('winners:', st.lastResult.winners.map((w) => `${w.name} +${w.amount}`).join(', '));
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
    { name: 'Alice', settings: { variant: VARIANT, smallBlind: 5, bigBlind: 10, startingStack: 1000, maxSeats: 8 } },
    (ack) => {
      hostId = ack.playerId;
      log('[host] created room', ack.roomId, 'variant', VARIANT);
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
  log('TIMEOUT: hand did not complete');
  process.exit(2);
}, 15000);
