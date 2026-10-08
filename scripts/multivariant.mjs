// Verifies the host can switch variants between hands: play a Texas hand, then
// switch to Dirty Omaha and play a manual-select hand. Checks the variant changed
// and a 4-card selection showdown happened.
import { io } from 'socket.io-client';

const URL = process.env.SMOKE_URL ?? 'http://localhost:3001';
const log = (...a) => console.log(...a);
const connect = () => io(URL, { transports: ['websocket'], forceNew: true });

const approved = new Set();
let hand1Started = false;
let hand1Done = false;
let finished = false;
let sawOmahaSelect = false;
const selected = new Set();

function driver(sock, getId, label) {
  sock.on('errorMsg', (m) => log(`[${label}] error: ${m}`));
  sock.on('roomState', (st) => {
    // Dealer's choice: whoever is on the clock picks the game (and Number's target).
    if (st.youAreDealer && st.awaitingDealerPick) {
      if (st.awaitingTripleNineTarget) sock.emit('hostSetTripleNineNumber', 500);
      else sock.emit('hostSetVariant', st.game.handNumber === 0 ? 'texas' : 'dirty-omaha');
    }
    const myId = getId();

    if (st.youAreHost && st.joinRequests) {
      for (const r of st.joinRequests) {
        if (!approved.has(r.requestId)) {
          approved.add(r.requestId);
          sock.emit('hostApproveJoin', r.requestId);
        }
      }
    }
    if (st.youAreHost && !hand1Started && st.players.length === 3 && st.game.phase === 'waiting') {
      hand1Started = true;
      log('[host] hand 1 variant =', st.settings.variant);
      sock.emit('startHand');
    }

    if (st.game.toAct === myId && st.availableActions) {
      const av = st.availableActions;
      const action = av.canCheck ? { type: 'check' } : av.canCall ? { type: 'call' } : { type: 'fold' };
      setTimeout(() => sock.emit('playerAction', action), 15);
    }

    if (st.youMustSelect && !selected.has(`${label}-${st.game.handNumber}`)) {
      selected.add(`${label}-${st.game.handNumber}`);
      sawOmahaSelect = true;
      setTimeout(() => sock.emit('selectCards', [0, 1]), 15);
    }

    // Hand 1 done -> host switches variant and starts hand 2 (in the same event).
    if (!hand1Done && st.game.handNumber === 1 && st.game.phase === 'showdown' && !st.game.awaitingSelection) {
      hand1Done = true;
      log('[*] hand 1 complete (texas)');
      if (st.youAreHost) {
        log('[host] starting hand 2 (dealer picks dirty-omaha)');
        sock.emit('startHand');
      }
    }

    // Hand 2 done.
    if (
      !finished &&
      st.game.handNumber === 2 &&
      st.game.phase === 'showdown' &&
      !st.game.awaitingSelection &&
      st.lastResult
    ) {
      finished = true;
      const total = st.players.reduce((s, p) => s + p.stack, 0);
      log('\n=== DONE ===');
      log('hand 2 variant:', st.settings.variant);
      log('saw 4-card omaha selection:', sawOmahaSelect);
      log('total chips (expect 3000):', total);
      const ok = st.settings.variant === 'dirty-omaha' && sawOmahaSelect && total === 3000;
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
    { name: 'Alice', settings: { variant: 'texas', smallBlind: 5, bigBlind: 10, startingStack: 1000, maxSeats: 8 } },
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
}, 20000);
