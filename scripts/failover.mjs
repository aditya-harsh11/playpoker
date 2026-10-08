// Failover test for the Docker Compose cluster (nginx + 3 servers + Redis).
//  1. Two players start a hand; the host's server is stopped mid-hand. The host reconnects
//     (nginx sends them to another server), rejoins, and the hand finishes with chips intact.
//  2. The host turns on auto-start, and their new server is stopped too. The next hand must
//     still auto-start, run by a surviving server from the timer queue in Redis.
// Stopped servers are started again at the end.
// Usage: docker compose up -d --build && node scripts/failover.mjs
import { io } from 'socket.io-client';
import { execSync } from 'node:child_process';

const URL = process.env.SMOKE_URL ?? 'http://localhost:8080';
const PREFIX = process.env.CONTAINER_PREFIX ?? 'playpoker-';
const log = (...a) => console.log(...a);
const connect = () => io(URL, { transports: ['websocket'], forceNew: true });
const container = (serverId) => `${PREFIX}${serverId}-1`;

const stopped = new Set();
function stopServer(serverId) {
  log(`[test] stopping ${serverId}`);
  execSync(`docker stop -t 0 ${container(serverId)}`, { stdio: 'ignore' });
  stopped.add(serverId);
}
function finish(code, msg) {
  log(msg);
  for (const id of stopped) execSync(`docker start ${container(id)}`, { stdio: 'ignore' });
  process.exit(code);
}

let roomId = '';
let stage = 'deal'; // deal -> killed -> autostart -> killed2
const players = {};

function driver(label, sock) {
  const me = { sock, id: '', token: '', serverId: '' };
  players[label] = me;
  sock.on('serverInfo', ({ serverId }) => {
    me.serverId = serverId;
    log(`[${label}] connected to ${serverId}`);
  });
  // On every reconnect, reclaim the seat with the saved token (what the real client does).
  sock.on('connect', () => {
    if (me.token) {
      sock.emit('rejoin', { roomId, token: me.token }, (ack) => log(`[${label}] rejoin: ${ack.ok ? 'ok' : ack.error}`));
    }
  });
  sock.on('errorMsg', (m) => log(`[${label}] error: ${m}`));
  sock.on('roomState', (st) => {
    if (st.youAreHost) {
      for (const r of st.joinRequests ?? []) sock.emit('hostApproveJoin', r.requestId);
      if (stage === 'deal' && st.players.length === 2 && st.game.phase === 'waiting' && !st.awaitingDealerPick) {
        sock.emit('startHand');
      }
    }
    if (st.youAreDealer && st.awaitingDealerPick) sock.emit('hostSetVariant', 'texas');

    // Mid-hand: kill the host's server once, right after the deal.
    if (stage === 'deal' && st.youAreHost && st.game.phase === 'preflop' && me.serverId) {
      stage = 'killed';
      stopServer(me.serverId);
      return;
    }

    if (st.game.toAct === me.id && st.availableActions) {
      const av = st.availableActions;
      setTimeout(() => sock.emit('playerAction', av.canCheck ? { type: 'check' } : { type: 'call' }), 20);
    }

    if (stage === 'killed' && st.lastResult && st.game.phase === 'showdown') {
      const total = st.players.reduce((s, p) => s + p.stack, 0);
      if (total !== 2000) finish(1, `FAIL: chips ${total}, expected 2000`);
      log(`PASS 1: hand finished after a server died (chips conserved: ${total})`);
      stage = 'autostart';
      if (st.youAreHost) {
        players.host.sock.emit('hostSetAutoStart', { enabled: true, seconds: 3 });
      }
    }

    if (stage === 'autostart' && st.youAreHost && st.autoStartAt) {
      stage = 'killed2';
      stopServer(me.serverId);
      return;
    }

    if (stage === 'killed2' && st.awaitingDealerPick) {
      finish(0, 'PASS 2: auto-start fired after the server that armed it died');
    }
  });
  return me;
}

const host = driver('host', connect());
host.sock.once('connect', () => {
  host.sock.emit(
    'createRoom',
    { name: 'Alice', settings: { variant: 'texas', smallBlind: 5, bigBlind: 10, startingStack: 1000, maxSeats: 8 } },
    (ack) => {
      roomId = ack.roomId;
      host.id = ack.playerId;
      host.token = ack.token;
      log('[host] created room', roomId);
      const bob = driver('bob', connect());
      bob.sock.once('connect', () => {
        bob.sock.emit('joinRoom', { roomId, name: 'Bob' }, (jack) => {
          bob.id = jack.playerId;
          bob.token = jack.token;
        });
      });
    },
  );
});

setTimeout(() => finish(2, `TIMEOUT at stage "${stage}"`), 40_000);
