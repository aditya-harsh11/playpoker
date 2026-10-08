# Play Poker — Dev Notes

Working reference for the codebase: how it's put together, the non-obvious bits, and how to
run/extend it. (User-facing intro is in `README.md`; deploying is under "Deployment" below.)

## What it is
A real-time, **play-chip** multiplayer poker room with every common variant on one table —
between hands, the dealer-on-the-button picks what gets dealt next. A host creates a game, shares a
link, and up to 8 guests join (host approves). The **server runs the whole game** — dealing,
blinds/antes, betting, all-ins, side pots, hand evaluation, pot awarding — across many independent
tables at once. It runs as **3 game servers behind nginx, sharing all tables through Redis**, so any
server can serve any player and a server can die mid-hand without the game stopping.

## Stack & layout (npm workspaces monorepo)
```
shared/   @poker/shared — TS types shared by client & server (cards, events, state, variants)
server/   Node + Express + Socket.IO + the authoritative game engine (run with tsx)
client/   React + Vite + Tailwind v4
scripts/  *.mjs end-to-end socket tests (run against a live server)
nginx/    nginx.conf — the load balancer in front of the 3 servers
Dockerfile, docker-compose.yml — the cluster: redis + server-1/2/3 + nginx
```
- **Shared types are the contract.** Client and server both import `@poker/shared`; the Socket.IO
  events are typed there (`ClientToServerEvents` / `ServerToClientEvents`).
- `tsx` runs the server directly from TS (no build step); it's a runtime dependency so production
  installs keep it.

## Run / build / test
```bash
npm install
docker compose up -d redis   # every server needs Redis (REDIS_URL, default redis://localhost:6379)
npm run dev        # server :3001 + client :5173 (concurrently)
npm test           # server engine unit tests (vitest) — no Redis needed
npm run build      # builds the client into client/dist
npm start          # runs one server; it also serves client/dist if built

docker compose up -d --build # the full cluster at http://localhost:8080
node scripts/failover.mjs    # kill-a-server tests against the cluster
```
**End-to-end socket scripts** (start a server first, point with `SMOKE_URL`; use
`http://localhost:8080` to run them through the cluster, so players land on different servers):
```bash
PORT=3010 npx tsx watch server/src/index.ts          # a server to test against
SMOKE_URL=http://localhost:3010 node scripts/smoke.mjs            # full Texas hand
VARIANT=dirty-omaha SMOKE_URL=... node scripts/variant.mjs        # manual-select variants
VARIANT=crazy-pineapple SMOKE_URL=... node scripts/pineapple.mjs  # discard variants
VARIANT=bomb-omaha SMOKE_URL=... node scripts/bomb.mjs            # bomb pots
node scripts/{reconnect,allinshow,note,handname,multivariant}.mjs
```
They assert invariants (chips conserved, correct phases) rather than exact winners (deck is random).
Each script's dealer picks `settings.variant` when put on the clock. `VARIANT=triple9` with
`variant.mjs` does **not** work (it picks 2 cards; Number needs an ordered 3) — the unit tests cover it.

## Architecture
**Server-authoritative.** The full deck and every hole card live only on the server. Each client
gets a **redacted, per-recipient snapshot** (`Room.snapshotFor(viewerId)`) — you only see your own
cards (others' only when revealed). Clients send *intents*; the server validates everything. Deck is
shuffled with `crypto.randomInt` (Fisher–Yates).

**Rooms.** Each `Room` is fully independent (its own players, chips, and current `PokerGame`).
Rooms live in **Redis**, not in any server's memory — see "Distributed setup" below. An event in one
room only re-broadcasts to that room.

**Flow:** client emits → `net/socketHandlers.ts` validates (zod for actions) →
`roomManager.withRoom(id, fn)` locks the table, loads it from Redis, runs `fn` (calls a `Room` method
→ `Room` mutates state / delegates to `PokerGame` → `broadcast(io, room)` sends each socket its own
snapshot), saves it, unlocks.

## Distributed setup
```
 players ──► nginx (:80, round-robin, WebSockets)
               ├─► server-1 ┐
               ├─► server-2 ├─► Redis (tables, locks, timers, pub/sub)
               └─► server-3 ┘
```
**Redis keys**
- `room:<id>` — the whole table as JSON (`rooms/serialize.ts`), 24h expiry refreshed on each save.
- `lock:room:<id>` — the table's lock (random token, 5s expiry).
- `timers` — sorted set of pending auto-start / auto-pick deadlines: member `<roomId>:autoStart` or
  `<roomId>:autoPick`, score = due time (ms).
- Socket.IO adapter pub/sub channels (`socket.io#…`).

**Save/load (`rooms/serialize.ts`).** Generic JSON with `Map`/`Set` tagged as `{__map}` / `{__set}`;
on load, the `Room` / `PokerGame` / `Deck` prototypes are restored (no `#private` fields anywhere, so
this works). `PokerGame.seats` holds **the same objects** as `room.players` (the engine mutates them),
so load re-links seats to `room.players` by id; a player removed mid-hand keeps their saved copy.
New fields on these classes are saved automatically. **Don't add `#private` fields, functions, or
class instances other than these three to `Room`/`PokerGame`** — they won't survive a save.

**Locking (`rooms/roomManager.ts`).** `withRoom` takes `SET lock:room:<id> <token> NX PX 5000`,
retrying for up to 3s, and releases with a Lua "delete only if still my token" script. The expiry
means a server that dies holding a lock can't freeze the table. Everything that changes a room goes
through `withRoom`; `create` uses `SET … NX` so two servers can't mint the same room id. A room left
with no players or requests is deleted on save.

**Messaging.** `@socket.io/redis-adapter`. `broadcast` / `pushHoleCards` still emit per socket id;
the adapter publishes them, and whichever server holds that socket delivers it. The server that made
the change builds every viewer's private snapshot — Redis only carries finished messages. The main
Redis connection is shared by data commands and the adapter's publishes, so a broadcast always
reaches Redis before the lock release that follows it (order is kept per connection).

**Timers.** `Room` no longer uses `setTimeout`. Scheduling only sets `autoStartAt` / `autoPickAt`;
every save mirrors those into `timers`. Each server polls `timers` every 500ms
(`startTimerPoller` in `socketHandlers.ts`); for a due entry, `ZREM` returning 1 means *this* server
won it (atomic, so exactly one does), and it runs `room.fireAutoStart()` / `fireAutoPick()` under the
lock. Those re-check the deadline, so a stale entry is harmless, and any later save re-adds an entry a
crashed server lost mid-claim.

**Connections.** The client is **WebSocket-only**, so a connection stays on one server and nginx can
round-robin without sticky sessions (long-polling would need them). If a server dies, its players'
sockets drop, the client reconnects (nginx skips the dead server — `proxy_next_upstream`) and re-sends
`rejoin`, which re-points their seat's `socketId`. The `disconnect` handler only clears `socketId` if
it still matches that socket, because the player may already be back through another server.
`connectionStateRecovery` was removed (this adapter doesn't support it; `rejoin` covers it).
Each server sends `serverInfo` (its `SERVER_ID`) on connect; the client shows it in the header so
you can watch a player move servers. `/health` also returns `serverId`.

### Key server files
- `engine/deck.ts` — secure shuffle + deal.
- `engine/handEvaluator.ts` — wraps `pokersolver`. `solve`, `compareHands`, `winnersAmong`,
  `bestHandUsing` (forces given hole cards), `handFromSelection`, `bestSelection` (best over allowed
  counts — powers the advisor). `describe()` strips the suit off kicker names ("Flush, Kd High" →
  "Flush, K High").
- `engine/blackjack.ts` — blackjack scoring (ace 1/11, naturals AK>AQ>AJ>A10, closest-to-21).
- `engine/sidePots.ts` — layered side-pot construction from per-player contributions.
- `engine/pokerGame.ts` — **the heart.** One hand's lifecycle + betting state machine.
- `rooms/room.ts` — lobby, seats, chip ledger, host controls, snapshot/redaction.
- `rooms/roomManager.ts` — Redis-backed table store: `create`, `withRoom` (lock/load/save), timer sync.
- `rooms/serialize.ts` — room ⇄ JSON.
- `redis.ts` — the two Redis connections (main + adapter subscriber).
- `net/socketHandlers.ts` (handlers + timer poller), `index.ts` (adapter, `SERVER_ID`, `/health`).

### Betting state machine (pokerGame.ts)
Per street it tracks `currentBet`, `minRaise`, `lastFullRaiseBet`, `actedThisStreet`,
`lastActedBet`, and `lastAggressorId` (last to bet/raise this street — drives showdown reveal
order; reset each street). A player is "settled" if folded/all-in or (matched `currentBet` AND
acted). Round ends when all are settled. Handles: blinds (heads-up button=SB), legal-action calc
(`availableActionsFor`), short all-ins **not** reopening betting, uncalled-bet return, side pots, and
all-in run-outs (deal remaining streets when ≤1 player can act).

**While the hand is paused for discards or card selection** (`awaitingDiscard` /
`awaitingSelection`), there is **no current actor**: `currentActorId`, `availableActionsFor`, and
`applyAction` all short-circuit. (Skipping this guard was the old "phantom actor" bug where a stale
Check/Fold bar appeared over the discard prompt and corrupted the round.)

### Showdown paths
- **Auto** (Texas / Pineapple / Crazy Pineapple — 2 cards by showdown): `resolveAutoShowdown` →
  `awardFromSolved`, best 5 of 7.
- **Manual select** (PLO, Dirty Omaha, 2-or-3, All 5, 1-3-5): pauses (`awaitingSelection`); each
  contender picks which hole cards to use (`submitSelection`), then `resolveSelectedShowdown`.
  - **Advisor notes** (private, in `notes` map → `RoomState.youNote`): losers who left a better hand
    get "you could have made X" (skipped if only kicker-different); players whose pick was already
    optimal get "Nicely played…"; winners get neither.
- **Bomb pots**: ante (fixed `BOMB_ANTE = 50`), no preflop, two boards (`board` + `board2`), each pot
  split 50/50 per board (`resolveBombShowdown`).
  - **Bomb Omaha** must use exactly 2 of 4 per board, so it **pauses for a two-board selection**
    (`bombNeedsSelection()` → `awaitingSelection`): each contender submits picks for both boards via
    `submitBombSelection(a, b)` (`selectBombCards` event); Board A → `selections`, Board B →
    `selectionsB`. Bomb Hold'em has nothing to choose, so it auto-resolves. Force/auto fills the
    best per board.
- **Blackjack Hold'em**: assign 2 cards to poker + 2 to blackjack; pot split 50/50
  (`resolveBlackjackShowdown`).
- **Number** (id `triple9`, 5 hole cards): assign 3 cards, **in order**, to a number vs. the dealer's
  target + 2 to poker; pot split 50/50 (`resolveTripleNineShowdown`). Card→digit: 2-9 = 2-9,
  T/J/Q/K = 0, A = 1 (`engine/tripleNine.ts`). The dealer sets the hand's target (0-999) as a *second*
  step after picking the variant — `Room.awaitingTripleNineTarget` (dealer stays locked via the same
  `pendingDealerId`, `awaitingDealerPick` stays true throughout) until `setTripleNineTargetAndDeal`
  fires, which deals. Unlike every other selection, `submitSelection`'s indices are **not sorted** for
  this variant — order is the digit order (hundreds→tens→ones), preserved end to end from the client's
  tap sequence through to `PokerGame.selections`. Auto-pick (dealer stalls past the timer) bypasses the
  number step too, same as it bypasses every other human choice — it rolls a random 0-999 target.
- **Fold-win**: `endHandByFold` (no reveal).
- **Reveal order at showdown** (`applyShowdownReveals`, used by `awardFromSolved`): standard poker
  order — the **last aggressor** on the final street shows first (or the **first live player left of
  the button** if the street was checked down), then clockwise (`revealOrder`). Each later contender
  only turns up if they **match/beat** the best hand shown so far; otherwise they **muck** (stay
  hidden). **All-in players always show.** Split-pot variants (bomb / blackjack) reveal **all**
  contenders (`revealAllContenders`) since "beats best" is ambiguous across two boards.
- **Showing after the hand:** everyone dealt in (incl. **folders and losers**) keeps their hole cards
  through the showdown window so they can optionally `showCards` (flash a bluff). Cards are wiped for
  all at the next `startHand`.

### Discards (Pineapple family)
`VariantConfig.discardSchedule = [afterFlop, afterTurn, afterRiver]`. After dealing each street the
engine pauses (`awaitingDiscard`, target = holeCards − cumulative schedule) until every contender
discards down to target, then opens betting. Pineapple = `[1]` (3→2); Crazy Pineapple = `[1,1,1]`
(5→2). Host "Force discard" / `forceResolve` auto-discards if someone stalls.

## Variant system
All variants are data in `shared/src/variants.ts` (`VARIANTS` record + `VARIANT_LIST`, a fixed
host-curated display order — not alphabetical). A `VariantConfig`: `holeCards`, `allowedHoleCounts`,
`manualSelect`, `discardSchedule`, `bombPot`, `blackjack`, `tripleNine`, `bettingStructure`.

**To add a variant:** add an entry to `VARIANTS` (and the `Variant` union + `VARIANT_ORDER`). The
engine reads the config — most variants need no engine changes. Only genuinely new mechanics (a new
pot structure, new eval) need code in `pokerGame.ts`. The picker modal (`VariantPicker`) is generated
from `VARIANT_LIST`, in `VARIANT_ORDER`'s order.

**Dealer's choice (per-hand variant):** the **upcoming dealer picks the game; the host deals.**
`Room.nextDealerId()` computes who's on the button next (mirrors `startHand`'s button logic) and the
snapshot exposes `nextDealerId` + `youAreDealer` (only between hands). The dealer opens
`VariantPicker` ("Change game" → `hostSetVariant` → `Room.setVariant`, rejected mid-hand; server
authorizes via `canPickGame` = dealer **or** host fallback before any dealer exists). `startHand` is
**host-only** (`requireHost`) and uses the current `settings.variant`. The client `TableControls`
shows these between hands: dealer sees "Your deal — pick the game" + Change game; host sees Deal.

## Client notes
- `lib/socket.ts` — single Socket.IO singleton, **WebSocket-only** (see Connections). Connects to
  `VITE_SERVER_URL` if set, else `:3001` in dev, else same-origin in prod. Reconnects forever with
  backoff. Remembers `currentServerId` from `serverInfo` (it arrives on connect, before any page listens).
- `lib/useRoom.ts` — subscribes to `roomState` / `yourCards` / `serverInfo`; tracks `connected` and
  `serverId`; on every (re)connect `GameRoom` re-sends `rejoin` with the localStorage session token, so
  a refresh/drop — or the player's server dying — reclaims your seat (token-based reconnection).
- **Reconnection UX (`GameRoom`):** while `!connected` a blocking **"Reconnecting…"** overlay covers
  the table (no clicking dead buttons). If `rejoin` comes back **"Room not found"** (server
  tables expired or Redis was wiped) it shows a **"Table unavailable"** screen (Home / Try again) instead
  of a stale, dead UI. "Session not found" (room alive, you were removed) → the join screen.
- `components/Table.tsx` — oval table; seats positioned by angle, rotated so **you** sit at the
  bottom. Rendered at a fixed design size (`DESIGN_W=1150`) and **scaled to fill the container width**
  via a ResizeObserver (cap `MAX_SCALE=1.25`; no blank side gutters), shrinking on phones. Seat pods
  sit outside the felt on an ellipse and can stick out past the design canvas at the horizontal/
  vertical extremes (e.g. the leftmost/rightmost seat at 8 players) — `bleedMargin()` reserves exactly
  enough canvas before fitting so pods never get clipped by the wrap's `overflow-hidden` (the side next
  to the action rail used to read as "covered by the sidebar"). Only face-up cards render (no backs);
  your own cards dock in your pod. A small **recycle icon + count** by a name shows that player's
  `rebuys`. Shows the Number variant's target (`game.tripleNineTarget`) above the board when set.
- `components/PlayingCard.tsx` — `xs/sm/md/lg` sizes (bumped larger this round; `lg` = board).
- `components/VariantPicker.tsx` — modal listing **every** variant + rules, in `VARIANT_LIST`'s fixed
  order (dealer's "Change game"); closes on Close / backdrop / Esc.
- `components/NumberField.tsx` — drop-in replacement for `<input type="number">` bound to numeric
  state. Plain `value={n} onChange={... Number(e.target.value)}` snaps a cleared field to `0`
  immediately, so it never actually goes empty — the next digit types in *after* that leftover zero
  ("7" cleared then "3" typed → "03"). This tracks its own text buffer instead, only committing valid
  numbers upward, and only re-syncs to the external value on blur. Used everywhere a numeric input
  binds to numeric state (Home's settings, ActionBar's raise box, HostPanel's auto-timer seconds, the
  Number target picker).
- `pages/GameRoom.tsx` panels: `TableStatus` (dealer picks / host deals / Number's target-pick wait,
  between hands), `ChooseTray` (discard / single-board select) + `BombSelectTray` (two-board Omaha
  select) + `TripleNineTray` (Number's ordered 3-card picker — order forms the digits, so picks are
  tracked as an array, not a set), `TripleNinePicker` (dealer's target-number entry, shown once they
  pick Number — mirrors `VariantPicker`'s forced/non-dismissable pattern), `ShowHandControls` ("Show
  your hand" — works even if you folded/lost), `ActionBar`. `SettleUp` ("End game", host-only) computes
  a minimal set of payments from `netResult` (`lib/settle.ts`) so the table can cash out.
- `components/Dropdown.tsx` — themed dropdown (now unused after the picker moved to the modal; kept as
  a reusable component).
- UI theme = "Midnight Poker": Fraunces (display) / Outfit (body) / Space Mono (numbers); design
  tokens + `.panel`/`.btn`/`.felt` in `index.css`.

## Resilience (server)
- Every socket handler is registered through a `safe`/`on` wrapper in `socketHandlers.ts` that
  try/catches (and awaits — handlers are async now) — a throw in one handler can't crash the process.
- `index.ts` adds `uncaughtException` / `unhandledRejection` logging (last-resort) and tuned
  `pingInterval`/`pingTimeout` (20s/20s). The client retries reconnection forever.
- Any one server can die (or be redeployed) without losing tables; see Distributed setup.
  Redis keeps an append-only file on a Docker volume, so even a Redis restart keeps tables.
- `scripts/failover.mjs` proves both halves: a hand finishes after the host's server is stopped
  mid-hand, and an auto-deal still fires after the server that armed it is stopped.

## Deployment
**The cluster** (`docker-compose.yml`): `redis` (redis:7-alpine, AOF on, 64 MB cap, `noeviction` so
game data is never dropped; bound to `127.0.0.1:6379` for local dev only), `server-1/2/3` (one image
from `Dockerfile`, different `SERVER_ID`, 200 MB / 128 MB heap caps), `nginx` (host port
`HTTP_PORT`, default 8080). All `restart: unless-stopped` — a crash restarts, a `docker stop` stays
stopped (for demos). nginx re-resolves container names every 5s (`resolve`) so a restarted container's
new IP is picked up. Whole cluster uses ~350 MB.

**Hosting: Google Cloud free tier (e2-micro, free forever within limits).**
1. Create a GCP account (asks for a card; the free tier doesn't charge). Set a **budget alert**
   (Billing → Budgets) at e.g. $1 so any surprise cost emails you.
2. Compute Engine → Create instance: machine **e2-micro**, region **us-central1, us-east1 or
   us-west1** (only these are free), boot disk **Ubuntu LTS, 30 GB standard persistent disk**,
   firewall: **allow HTTP**. Check the free-tier page for current terms — Google may charge a small
   amount for the external IPv4 address.
3. SSH in (button in the console), then:
   ```bash
   # 2 GB swap — the VM has 1 GB RAM
   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile \
     && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   # Docker
   curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER && newgrp docker
   # The app
   git clone <your repo url> playpoker && cd playpoker
   HTTP_PORT=80 docker compose up -d --build
   ```
4. Play at `http://<VM external IP>`. To update: `git pull && HTTP_PORT=80 docker compose up -d --build`
   (servers restart one image at a time; tables survive in Redis).
5. Optional: a free DuckDNS subdomain + Let's Encrypt for HTTPS (nginx would need a 443 server block).

Outgoing data is only ~1 GB/month free; a card game sends little, but watch it if it gets popular.

**Scale.** More servers = more `server-N` entries in compose + `nginx.conf`. Redis is the single point
of failure (and the limit) — beyond one machine you'd add Redis replication/Sentinel and run servers
on separate VMs.

## Gotchas
- **State is in Redis**: server restarts (and `tsx watch` reloads in dev) keep tables. Wiping Redis
  (`docker compose down -v`) or 24h of inactivity removes them. Changing the shape of `Room` /
  `PokerGame` can break loading tables saved by older code — wipe Redis after such changes in dev.
- **Never touch a room outside `withRoom`** — a change made without the lock, or not saved, is lost
  or races another server.
- **One browser = one identity** (session token in localStorage, keyed by room). Test multiple
  players with separate browsers / incognito / devices.
- Snapshots are **per-recipient** — don't leak data by broadcasting one shared payload; always go
  through `Room.snapshotFor`.
- **Free-tier VM has 1 GB RAM** — keep the swap file, and keep an eye on memory before adding services.
- Hand evaluation/comparison is delegated to `pokersolver`; the selection/advisor logic forces
  specific hole cards via `bestHandUsing`, so don't replace it with a plain `solve` of the union.
- `pokersolver` is CommonJS — import the default and destructure (`import pkg from 'pokersolver'`).
