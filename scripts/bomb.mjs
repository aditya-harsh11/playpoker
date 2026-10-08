// End-to-end test of a Bomb Pot: antes, no preflop, two boards, split pot.
// Usage: VARIANT=bomb-holdem SMOKE_URL=http://localhost:3010 node scripts/bomb.mjs
import { io } from 'socket.io-client';

const URL = process.env.SMOKE_URL ?? 'http://localhost:3001';
const VARIANT = process.env.VARIANT ?? 'bomb-holdem';
const log = (...a) => console.log(...a);
const connect = () => io(URL, { transports: ['websocket'], forceNew: true });

const approved = new Set();
const selected = new Set();
let started = false;
let finished = false;
let sawTwoBoards = false;

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

    if (st.game.communityCards2 && st.game.communityCards2.length > 0) sawTwoBoards = true;

    // Bomb Omaha: choose 2 hole cards for each board when prompted.
    if (st.youMustSelect && !selected.has(label)) {
      selected.add(label);
      const me = st.players.find((p) => p.id === myId);
      const idx = (me?.holeCards ?? []).map((_, i) => i).slice(0, 2);
      setTimeout(() => sock.emit('selectBombCards', { a: idx, b: [idx[1], idx[0]] }), 15);
    }

    if (st.game.toAct === myId && st.availableActions) {
      const av = st.availableActions;
      const action = av.canCheck ? { type: 'check' } : av.canCall ? { type: 'call' } : { type: 'fold' };
      setTimeout(() => sock.emit('playerAction', action), 15);
    }

    if (!finished && st.lastResult && st.game.phase === 'showdown' && !st.game.awaitingSelection) {
      finished = true;
      const total = st.players.reduce((s, p) => s + p.stack, 0);
      log('\n=== HAND COMPLETE ===');
      log('Board A:', st.lastResult.board.map((c) => c.rank + c.suit).join(' '));
      log('Board B:', (st.lastResult.board2 ?? []).map((c) => c.rank + c.suit).join(' '));
      log('winners:', st.lastResult.winners.map((w) => `${w.name} +${w.amount} (Board ${w.board})`).join(', '));
      log('two boards dealt:', sawTwoBoards);
      log('total chips (expect 3000):', total);
      const ok = total === 3000 && sawTwoBoards && (st.lastResult.board2 ?? []).length === 5;
      log(ok ? 'PASS' : 'FAIL');
      setTimeout(() => process.exit(ok ? 0 : 1), 100);
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
      log('[host] created room', ack.roomId);
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
