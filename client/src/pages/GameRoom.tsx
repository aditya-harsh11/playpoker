import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { SUIT_SYMBOL, VARIANTS, VARIANT_LIST, selectionHint, type Card, type RoomState } from '@poker/shared';
import { socket } from '../lib/socket';
import { useRoom } from '../lib/useRoom';
import { useCountdown } from '../lib/useCountdown';
import { joinRoom, rejoin, api } from '../lib/api';
import { loadSession, saveSession, clearSession } from '../lib/session';
import { computeSettlement } from '../lib/settle';
import Table from '../components/Table';
import ActionBar from '../components/ActionBar';
import HostPanel from '../components/HostPanel';
import PlayingCard from '../components/PlayingCard';
import VariantPicker from '../components/VariantPicker';
import NumberField from '../components/NumberField';

function ResultBanner({ state }: { state: RoomState }) {
  const r = state.lastResult;
  if (!r || state.game.phase !== 'showdown') return null;
  return (
    <div className="rounded-xl bg-black/40 px-4 py-2 text-center text-sm ring-1 ring-brass/20">
      {r.winners.length === 0 ? (
        <span className="text-ink-dim">Hand complete</span>
      ) : (
        r.winners.map((w, i) => {
          // Render as: "Name wins 360, Two Pair (Board A)" — bracket label clarifies
          // which pot they won (bomb board / poker-vs-blackjack split) when relevant.
          const bracket = w.label ?? (w.board ? `Board ${w.board}` : null);
          return (
            <span
              key={`${w.playerId}-${w.board ?? w.label ?? ''}-${i}`}
              className="mr-3 font-semibold text-brass-bright"
            >
              {w.name} wins {w.amount.toLocaleString()}
              {w.handName && (
                <>
                  ,{' '}
                  <span className="font-normal text-ink">{w.handName}</span>
                </>
              )}
              {bracket && <span className="ml-1 font-normal text-ink-dim">({bracket})</span>}
            </span>
          );
        })
      )}
    </div>
  );
}

/**
 * Bottom-strip status line for between-hand states. Distinct messages:
 *   - awaitingDealerPick + you're the dealer: prompt to pick (modal also opens)
 *   - awaitingDealerPick + you're not the dealer: "Waiting for [Name] to pick…"
 *   - awaitingTripleNineTarget (Number, after the variant's picked): "Waiting for
 *     [Name] to pick a number…" (the dealer sees the number-entry modal instead)
 *   - idle (showdown / waiting before host starts): explain who'll do what
 */
function TableStatus({ state, onOpenPicker }: { state: RoomState; onOpenPicker: () => void }) {
  // Called before any early return to satisfy rules-of-hooks; null target → null result.
  const autoLeft = useCountdown(state.autoStartAt);
  const pickLeft = useCountdown(state.autoPickAt);
  const handInProgress = state.game.phase !== 'waiting' && state.game.phase !== 'showdown';
  if (handInProgress || state.game.awaitingSelection || state.game.awaitingDiscard) return null;

  const dealer = state.players.find((p) => p.id === state.nextDealerId);
  const host = state.players.find((p) => p.id === state.hostId);

  // Each status pill is w-fit so it floats on the table background instead of
  // stretching across the full screen width.
  const pill =
    'flex w-fit items-center justify-center gap-2 rounded-full bg-black/45 px-3 py-1 text-center text-xs ring-1 ring-brass/20 backdrop-blur-sm';

  // Number: dealer picked the variant, now sets the target — the number-entry modal
  // covers this for the dealer, so only render the waiting pill for everyone else.
  if (state.awaitingTripleNineTarget) {
    if (state.youAreDealer) return null;
    return (
      <div className={`${pill} text-ink-dim`}>
        Waiting for <span className="font-semibold text-brass-bright">{dealer?.name ?? 'the dealer'}</span> to pick a
        number…
      </div>
    );
  }

  if (state.awaitingDealerPick) {
    const autoPickNote =
      state.autoPick.enabled && pickLeft != null ? (
        <span className="text-amber-300">· auto-picks in {pickLeft}s</span>
      ) : null;
    if (state.youAreDealer) {
      return (
        <div className={pill}>
          <span className="text-brass-bright">It's your deal, pick the game to deal the hand.</span>
          {autoPickNote}
          <button onClick={onOpenPicker} className="btn btn-gold px-3 py-1 text-xs">
            Pick the game
          </button>
        </div>
      );
    }
    return (
      <div className={`${pill} text-ink-dim`}>
        Waiting for{' '}
        <span className="font-semibold text-brass-bright">{dealer?.name ?? 'the dealer'}</span> to pick the game…{' '}
        {autoPickNote}
      </div>
    );
  }

  // Auto-deal armed: show the shared countdown to everyone at the table.
  if (state.autoStart.enabled && autoLeft != null) {
    return (
      <div className={`${pill} text-emerald-200`}>
        Next hand in <span className="font-semibold text-emerald-300">{autoLeft}s</span>…
      </div>
    );
  }

  // Idle: nothing for the host (their HostPanel has the Start button), and a hint for
  // everyone else explaining who'll be on the clock once the host kicks things off.
  if (state.youAreHost) return null;
  return (
    <div className={`${pill} text-ink-dim`}>
      {dealer ? (
        <>
          <span className="font-semibold text-brass-bright">{host?.name ?? 'host'}</span> starts the hand ·{' '}
          <span className="font-semibold text-brass-bright">{dealer.name}</span> picks the game
        </>
      ) : (
        'Waiting for enough players…'
      )}
    </div>
  );
}

/**
 * Bomb Omaha: pick 2 of your 4 hole cards for Board A — the other 2 automatically
 * play Board B. Same visual idiom as Blackjack Hold'em: picked cards get a green
 * "A" badge, the auto-assigned remainder get a sky "B" badge.
 */
function BombSelectTray({ state }: { state: RoomState }) {
  const me = state.players.find((p) => p.id === state.youId);
  const cards = me?.holeCards ?? [];
  const variant = VARIANTS[state.settings.variant];
  const need = Math.max(...variant.allowedHoleCounts);
  const [selA, setSelA] = useState<number[]>([]);

  if (cards.length === 0) return null;

  const toggle = (i: number) =>
    setSelA((cur) => {
      if (cur.includes(i)) return cur.filter((x) => x !== i);
      const next = [...cur, i];
      return next.length > need ? next.slice(next.length - need) : next;
    });

  const canConfirm = selA.length === need;
  const selB = cards.map((_, i) => i).filter((i) => !selA.includes(i));
  const decided = selA.length === need;

  return (
    <div className="mx-auto flex w-fit flex-col items-center gap-3 rounded-2xl bg-black/45 px-4 py-3 ring-1 ring-brass/20 backdrop-blur-sm">
      <div className="flex flex-wrap items-end justify-center gap-2">
        {cards.map((card, i) => (
          <PartitionCard
            key={i}
            card={card}
            picked={selA.includes(i)}
            decided={decided}
            pickedBadge="A"
            otherBadge="B"
            onToggle={() => toggle(i)}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3 text-sm">
        <span className="text-ink-dim">
          Pick {need} for <span className="text-emerald-300">Board A</span> · other {need} play{' '}
          <span className="text-sky-300">Board B</span>
        </span>
        <button
          disabled={!canConfirm}
          onClick={() => api.selectBombCards(selA, selB)}
          className="btn btn-emerald px-5 py-2"
        >
          Confirm
        </button>
      </div>
    </div>
  );
}

/**
 * Card button for "pick N of your hand; the rest play a different role" pickers.
 * Picked cards get a green ring + a badge for the picked role (e.g. "A", "P");
 * once enough are picked, the remainder get a sky ring + the other-role badge
 * (e.g. "B"). Used by Bomb Omaha and Blackjack Hold'em.
 */
function PartitionCard({
  card,
  picked,
  decided,
  pickedBadge,
  otherBadge,
  onToggle,
}: {
  card: Card;
  picked: boolean;
  decided: boolean;
  pickedBadge: string;
  otherBadge: string;
  onToggle: () => void;
}) {
  const ring = picked
    ? 'ring-4 ring-emerald-400 shadow-[0_0_16px_rgba(52,211,153,0.7)] -translate-y-2'
    : decided
      ? 'ring-2 ring-sky-300/70 opacity-90'
      : 'opacity-70 hover:-translate-y-1 hover:opacity-100';
  return (
    <button onClick={onToggle} className={`relative rounded-lg transition ${ring}`}>
      <PlayingCard card={card} size="sm" />
      {picked && (
        <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-400 text-[10px] font-bold text-black">
          {pickedBadge}
        </span>
      )}
      {!picked && decided && (
        <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-sky-300 text-[10px] font-bold text-black">
          {otherBadge}
        </span>
      )}
    </button>
  );
}

/**
 * Number: tap 3 of your 5 cards, in order, to build a 3-digit number against the
 * dealer's target (2-9 = 2-9, T/J/Q/K = 0, A = 1 — first tap is the hundreds digit).
 * The other 2 automatically play a normal poker hand. Unlike every other selection
 * tray, order matters here, so picks are tracked as an ordered array, not a set.
 */
function TripleNineTray({ state }: { state: RoomState }) {
  const me = state.players.find((p) => p.id === state.youId);
  const cards = me?.holeCards ?? [];
  const [order, setOrder] = useState<number[]>([]);

  if (cards.length === 0) return null;

  const digitOf = (card: Card) => (card.rank === 'A' ? 1 : ['T', 'J', 'Q', 'K'].includes(card.rank) ? 0 : Number(card.rank));

  const toggle = (i: number) =>
    setOrder((cur) => {
      if (cur.includes(i)) return cur.filter((x) => x !== i);
      if (cur.length >= 3) return cur;
      return [...cur, i];
    });

  const canConfirm = order.length === 3;
  const numberPreview = order.map((i) => digitOf(cards[i])).join('');

  return (
    <div className="mx-auto flex w-fit flex-col items-center gap-3 rounded-2xl bg-black/45 px-4 py-3 ring-1 ring-brass/20 backdrop-blur-sm">
      <div className="flex flex-wrap items-end justify-center gap-2">
        {cards.map((card, i) => {
          const pos = order.indexOf(i);
          const picked = pos !== -1;
          const ring = picked
            ? 'ring-4 ring-emerald-400 shadow-[0_0_16px_rgba(52,211,153,0.7)] -translate-y-2'
            : canConfirm
              ? 'ring-2 ring-sky-300/70 opacity-90'
              : 'opacity-70 hover:-translate-y-1 hover:opacity-100';
          return (
            <button key={i} onClick={() => toggle(i)} className={`relative rounded-lg transition ${ring}`}>
              <PlayingCard card={card} size="sm" />
              {picked && (
                <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-400 text-[10px] font-bold text-black">
                  {pos + 1}
                </span>
              )}
              {!picked && canConfirm && (
                <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-sky-300 text-[10px] font-bold text-black">
                  P
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3 text-sm">
        <span className="text-ink-dim">
          Tap 3 in order for your <span className="text-emerald-300">number</span>
          {canConfirm && (
            <>
              {': '}
              <span className="font-mono font-bold text-brass-bright">{numberPreview}</span>
            </>
          )}{' '}
          · other 2 play <span className="text-sky-300">Poker</span>
        </span>
        <button disabled={!canConfirm} onClick={() => api.selectCards(order)} className="btn btn-emerald px-5 py-2">
          Confirm
        </button>
      </div>
    </div>
  );
}

/** Only rendered when the player must choose cards (select or discard). */
function ChooseTray({ state }: { state: RoomState }) {
  const me = state.players.find((p) => p.id === state.youId);
  const cards = me?.holeCards ?? [];
  const variant = VARIANTS[state.settings.variant];
  const mode: 'discard' | 'select' | 'none' = state.youMustDiscard
    ? 'discard'
    : state.youMustSelect
      ? 'select'
      : 'none';
  const [sel, setSel] = useState<number[]>([]);

  if (mode === 'none' || cards.length === 0) return null;
  // Bomb pots that require choosing (Bomb Omaha) use a dedicated two-board chooser.
  if (mode === 'select' && variant.bombPot) return <BombSelectTray state={state} />;
  // Number: order matters (it forms the digits), so it gets its own ordered picker.
  if (mode === 'select' && variant.tripleNine) return <TripleNineTray state={state} />;

  const toggle = (i: number) => {
    if (mode === 'discard') setSel((cur) => (cur[0] === i ? [] : [i]));
    else setSel((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]));
  };
  const isDiscard = mode === 'discard';
  const ring = isDiscard ? 'ring-crimson' : 'ring-emerald-400';
  const glow = isDiscard
    ? 'shadow-[0_0_18px_rgba(184,85,74,0.75)]'
    : 'shadow-[0_0_18px_rgba(52,211,153,0.75)]';
  const canConfirm = isDiscard ? sel.length === 1 : variant.allowedHoleCounts.includes(sel.length);
  const confirm = () => (isDiscard ? api.discardCard(sel[0]) : api.selectCards(sel));
  // Blackjack Hold'em is a partition pick: 2 cards become poker, the other 2 become
  // blackjack. Render with P/B badges (same idiom as Bomb Omaha's A/B).
  const isPartition = !isDiscard && variant.blackjack;
  const partitionNeed = isPartition ? 2 : 0;
  const partitionDecided = isPartition && sel.length === partitionNeed;

  return (
    <div className="mx-auto flex w-fit flex-col items-center gap-2 rounded-2xl bg-black/45 px-4 py-3 ring-1 ring-brass/20 backdrop-blur-sm">
      <div className="flex flex-wrap items-end justify-center gap-2.5">
        {cards.map((card, i) => {
          const selected = sel.includes(i);
          if (isPartition) {
            return (
              <PartitionCard
                key={i}
                card={card}
                picked={selected}
                decided={partitionDecided}
                pickedBadge="P"
                otherBadge="B"
                onToggle={() => toggle(i)}
              />
            );
          }
          return (
            <button
              key={i}
              onClick={() => toggle(i)}
              className={`relative rounded-lg transition ${
                selected
                  ? `-translate-y-3 ring-4 ${ring} ${glow}`
                  : 'opacity-60 hover:-translate-y-1 hover:opacity-100'
              }`}
            >
              <PlayingCard card={card} size="md" />
              {selected && (
                <span
                  className={`absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                    isDiscard ? 'bg-crimson text-white' : 'bg-emerald-400 text-black'
                  }`}
                >
                  {isDiscard ? '✕' : '✓'}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 text-sm">
        <span className="text-ink-dim">
          {mode === 'discard' ? (
            `Pick a card to discard (${sel.length}/1)`
          ) : isPartition ? (
            <>
              Pick 2 for <span className="text-emerald-300">Poker</span> · other 2 play{' '}
              <span className="text-sky-300">Blackjack</span>
            </>
          ) : (
            `Choose ${selectionHint(variant.allowedHoleCounts)}`
          )}
        </span>
        <button
          disabled={!canConfirm}
          onClick={confirm}
          className={`btn px-5 py-2 ${mode === 'discard' ? 'btn-danger' : 'btn-emerald'}`}
        >
          {mode === 'discard' ? 'Discard' : 'Confirm'}
        </button>
      </div>
    </div>
  );
}

/** After a hand, let the player reveal their own cards — even if they folded or lost. */
function ShowHandControls({ state }: { state: RoomState }) {
  const me = state.players.find((p) => p.id === state.youId);
  const cards = me?.holeCards ?? [];
  if (state.game.phase !== 'showdown' || state.game.awaitingSelection || cards.length === 0) return null;
  const shown = me?.shown ?? [];
  const allShown = cards.every((_, i) => shown.includes(i));

  return (
    // w-fit pill so the controls hug their content and float on the background
    // instead of stretching across the full screen width.
    <div className="mx-auto flex w-fit flex-col items-center gap-1.5 rounded-2xl bg-black/45 px-4 py-2 ring-1 ring-brass/20 backdrop-blur-sm">
      <span className="text-sm font-semibold text-brass-bright">
        {allShown ? 'Your hand is shown' : 'Show your hand'}
        {!allShown && <span className="ml-1 font-normal text-ink-dim">(optional)</span>}
      </span>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {cards.map((c, i) => (
          <button
            key={i}
            disabled={shown.includes(i)}
            onClick={() => api.showCards([i])}
            className="btn btn-ghost px-3 py-1.5"
          >
            {shown.includes(i) ? 'Shown ' : ''}
            {c.rank}
            <span className={c.suit === 'h' || c.suit === 'd' ? 'text-crimson' : ''}>{SUIT_SYMBOL[c.suit]}</span>
          </button>
        ))}
        <button
          disabled={allShown}
          onClick={() => api.showCards(cards.map((_, i) => i))}
          className="btn btn-gold px-4 py-1.5"
        >
          {cards.length === 2 ? 'Show both' : `Show all (${cards.length})`}
        </button>
      </div>
    </div>
  );
}

/**
 * Number: after the dealer picks the variant, they set this hand's target (0-999)
 * before it deals — mirrors VariantPicker's forced, non-dismissable "you're on the
 * clock" pattern, since picking the game already committed to needing this input.
 */
function TripleNinePicker({ onConfirm }: { onConfirm: (n: number) => void }) {
  const [n, setN] = useState(0);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-3">
      <div className="panel w-full max-w-sm rounded-2xl p-5">
        <h2 className="font-display text-xl text-brass-bright sm:text-2xl">Pick the number</h2>
        <p className="mt-0.5 text-xs text-ink-dim">It's your deal, set this hand's target, then deal.</p>
        <p className="mt-3 text-xs leading-snug text-ink-dim">
          Everyone's closest 3-card number wins half the pot. 2-9 = 2-9, T/J/Q/K = 0, A = 1.
        </p>
        <div className="mt-4 flex items-center justify-center">
          <NumberField
            min={0}
            max={999}
            value={n}
            onChange={(v) => setN(Math.max(0, Math.min(999, Math.floor(v))))}
            className="w-32 rounded-lg border border-brass/30 bg-black/40 px-3 py-2 text-center font-mono text-3xl font-bold text-ink outline-none focus:border-brass/60"
          />
        </div>
        <button onClick={() => onConfirm(n)} className="btn btn-gold mt-4 w-full py-2.5">
          Deal
        </button>
      </div>
    </div>
  );
}

function ShareBar({ roomId }: { roomId: string }) {
  const url = `${window.location.origin}/game/${roomId}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5 text-sm">
      <span className="hidden shrink-0 text-xs text-ink-dim sm:inline">Invite</span>
      <code className="hidden min-w-0 max-w-[18vw] select-all truncate rounded-md bg-black/40 px-2 py-1 text-xs text-brass ring-1 ring-brass/15 md:inline-block">
        {url}
      </code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="btn btn-ghost px-2.5 py-1.5 text-xs sm:px-3"
        title={url}
      >
        {copied ? 'Copied!' : 'Copy invite'}
      </button>
    </div>
  );
}

function Ledger({ state, onClose }: { state: RoomState; onClose: () => void }) {
  const rows = [...state.players].sort((a, b) => b.netResult - a.netResult);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="panel w-full max-w-md rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-2xl text-brass-bright">Ledger</h2>
          <button onClick={onClose} className="btn btn-ghost px-3 py-1 text-xs">
            Close
          </button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-ink-dim">
              <th className="pb-1">Player</th>
              <th className="pb-1 text-right">Bought in</th>
              <th className="pb-1 text-right">Stack</th>
              <th className="pb-1 text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-brass/10">
                <td className="py-1.5 font-medium">{p.name}</td>
                <td className="py-1.5 text-right font-mono text-ink-dim">{p.boughtIn.toLocaleString()}</td>
                <td className="py-1.5 text-right font-mono text-emerald-300">{p.stack.toLocaleString()}</td>
                <td className={`py-1.5 text-right font-mono ${p.netResult >= 0 ? 'text-emerald-400' : 'text-crimson'}`}>
                  {p.netResult >= 0 ? '+' : ''}
                  {p.netResult.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-ink-dim">Net = current stack − total bought in.</p>
      </div>
    </div>
  );
}

/** "Who pays who" — settle up: the minimal set of payments that clears everyone's net result. */
function SettleUp({ state, onClose }: { state: RoomState; onClose: () => void }) {
  const payments = computeSettlement(state.players);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="panel w-full max-w-md rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-2xl text-brass-bright">Settle up</h2>
          <button onClick={onClose} className="btn btn-ghost px-3 py-1 text-xs">
            Close
          </button>
        </div>
        {payments.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-dim">Everyone's even, no payments needed.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {payments.map((p, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-2 rounded-xl bg-black/30 p-3 ring-1 ring-brass/10"
              >
                <span className="text-sm">
                  <span className="font-semibold text-crimson">{p.from}</span>
                  <span className="mx-1.5 text-ink-dim">pays</span>
                  <span className="font-semibold text-emerald-300">{p.to}</span>
                </span>
                <span className="font-mono text-lg font-bold text-brass-bright">{p.amount.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-ink-dim">
          Based on each player's net result (stack − bought in) right now.
        </p>
      </div>
    </div>
  );
}

export default function GameRoom() {
  const { roomId: rawId } = useParams();
  const roomId = (rawId ?? '').toLowerCase();
  const navigate = useNavigate();
  const { state, error, connected, serverId } = useRoom();

  const [needJoin, setNeedJoin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [showLedger, setShowLedger] = useState(false);
  const [showSettle, setShowSettle] = useState(false);
  const [showVariants, setShowVariants] = useState(false);
  const [showTripleNine, setShowTripleNine] = useState(false);
  const [showVariantInfo, setShowVariantInfo] = useState(false);
  const [tableGone, setTableGone] = useState(false);

  const attemptRejoin = useCallback(() => {
    const session = loadSession(roomId);
    if (!session) {
      setNeedJoin(true);
      return;
    }
    rejoin(roomId, session.token).then((ack) => {
      if (ack.ok) {
        setNeedJoin(false);
        setTableGone(false);
      } else if (/room not found/i.test(ack.error ?? '')) {
        // The table itself is gone (server restarted/slept) — don't leave a dead UI up.
        setTableGone(true);
      } else {
        clearSession(roomId);
        setNeedJoin(true);
      }
    });
  }, [roomId]);

  useEffect(() => {
    if (socket.connected) attemptRejoin();
    socket.on('connect', attemptRejoin);
    return () => {
      socket.off('connect', attemptRejoin);
    };
  }, [attemptRejoin]);

  // Open the variant picker for whoever is the on-the-clock dealer the moment the
  // server flips awaitingDealerPick on. Picking commits-and-deals atomically, so
  // showing the modal IS the prompt. We re-arm this every time the flag transitions
  // false→true so subsequent hands (not just hand 1) also prompt the dealer. Number
  // (Triple 9) needs one more input first: once the dealer picks it, the server flips
  // awaitingTripleNineTarget instead of dealing — swap to the number-entry modal.
  const awaitingPick = !!state?.awaitingDealerPick;
  const awaitingNumber = !!state?.awaitingTripleNineTarget;
  const youAreDealer = !!state?.youAreDealer;
  useEffect(() => {
    if (awaitingNumber && youAreDealer) {
      setShowVariants(false);
      setShowTripleNine(true);
    } else if (awaitingPick && youAreDealer) {
      setShowVariants(true);
    } else if (!awaitingPick) {
      // Server moved on (either dealt, or selection was cancelled / superseded).
      setShowVariants(false);
    }
    if (!awaitingNumber) setShowTripleNine(false);
  }, [awaitingPick, awaitingNumber, youAreDealer]);

  const doJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ack = await joinRoom(roomId, name || 'Player');
    setBusy(false);
    if (ack.ok) {
      saveSession(roomId, { playerId: ack.playerId, token: ack.token });
      setNeedJoin(false);
    } else {
      window.alert(ack.error);
    }
  };

  const leave = () => {
    api.leaveRoom();
    clearSession(roomId);
    navigate('/');
  };

  if (tableGone) {
    return (
      <div className="mx-auto flex min-h-full max-w-sm flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="font-display text-3xl text-brass-bright">Table unavailable</h1>
        <p className="text-sm text-ink-dim">
          This game is no longer on the server (it may have restarted). Start a fresh table or try
          reconnecting.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => {
              clearSession(roomId);
              navigate('/');
            }}
            className="btn btn-gold px-5 py-2.5"
          >
            Back to home
          </button>
          <button onClick={attemptRejoin} className="btn btn-ghost px-5 py-2.5">
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (needJoin) {
    return (
      <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-center font-display text-3xl text-brass-bright">Take a seat</h1>
        <p className="text-center text-sm text-ink-dim">
          Room <code className="text-brass">{roomId}</code>
        </p>
        <form onSubmit={doJoin} className="panel flex flex-col gap-3 rounded-2xl p-6">
          <input className="field" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
          <button disabled={busy} className="btn btn-gold py-3">
            {busy ? 'Joining…' : 'Request to join'}
          </button>
          <p className="text-center text-xs text-ink-dim">The host sets your chips once you're approved.</p>
        </form>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="flex min-h-full items-center justify-center font-display text-xl text-ink-dim">
        {connected ? 'Loading table…' : 'Connecting…'}
      </div>
    );
  }

  const me = state.players.find((p) => p.id === state.youId);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1800px] flex-col gap-2 p-2 sm:gap-3 sm:p-3 lg:h-screen lg:overflow-hidden">
      {!connected && (
        <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-3 bg-black/75 backdrop-blur-sm">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-brass/30 border-t-brass" />
          <p className="font-display text-xl text-brass-bright">Reconnecting…</p>
          <p className="text-sm text-ink-dim">Hang tight, restoring your seat.</p>
        </div>
      )}
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h1 className="font-display text-xl font-semibold text-brass-bright sm:text-2xl">Play Poker</h1>
          <span className="flex items-center gap-1 rounded-md bg-brass/15 px-2 py-0.5 text-xs font-semibold text-brass-bright ring-1 ring-brass/30 sm:px-2.5 sm:py-1 sm:text-sm">
            {VARIANTS[state.settings.variant].name}
          </span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowVariantInfo((v) => !v)}
              className="flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold text-brass-bright ring-1 ring-brass/30 transition hover:bg-brass/15"
              aria-label="Game modes"
            >
              ⓘ
            </button>
            {showVariantInfo && (
              <>
                <div className="fixed inset-0 z-[70]" onClick={() => setShowVariantInfo(false)} />
                <div className="absolute left-1/2 top-full z-[71] mt-1.5 w-56 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 sm:w-72">
                  <div className="panel flex max-h-56 flex-col rounded-lg sm:max-h-72">
                    <div className="flex items-center justify-between border-b border-brass/15 px-2.5 py-1.5 text-[11px] sm:px-3 sm:py-2 sm:text-xs">
                      <span className="text-ink-dim">
                        Blinds <span className="font-mono font-semibold text-ink">{state.settings.smallBlind}/{state.settings.bigBlind}</span>
                      </span>
                      <span className="text-ink-dim">
                        Hand <span className="font-mono font-semibold text-ink">{state.game.handNumber}</span>
                      </span>
                    </div>
                    <ul className="flex flex-col gap-1.5 overflow-y-auto p-2 sm:gap-2 sm:p-3">
                      {VARIANT_LIST.map((v) => {
                        const active = v.id === state.settings.variant;
                        return (
                          <li
                            key={v.id}
                            className={`rounded-lg p-1.5 ${active ? 'bg-brass/15 ring-1 ring-brass/40' : ''}`}
                          >
                            <div className="text-sm font-semibold text-ink sm:text-base">{v.name}</div>
                            <p className="mt-0.5 text-[11px] leading-snug italic text-ink-dim sm:text-xs">
                              {v.description}
                            </p>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              </>
            )}
          </div>
          {!connected && <span className="text-xs text-crimson">reconnecting…</span>}
          {connected && serverId && (
            <span className="font-mono text-[10px] text-ink-dim" title="Which server you're connected to">
              {serverId}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
          <button onClick={() => setShowLedger(true)} className="btn btn-ghost px-2.5 py-1.5 text-sm sm:px-3">
            Ledger
          </button>
          {state.youAreHost && (
            <button onClick={() => setShowSettle(true)} className="btn btn-ghost px-2.5 py-1.5 text-sm sm:px-3">
              Payouts
            </button>
          )}
          {me && me.status === 'sittingout' ? (
            <button onClick={() => api.sitIn()} className="btn btn-ghost px-2.5 py-1.5 text-sm sm:px-3">
              Sit in
            </button>
          ) : (
            me && (
              <button onClick={() => api.sitOut()} className="btn btn-ghost px-2.5 py-1.5 text-sm sm:px-3">
                Sit out
              </button>
            )
          )}
          <button onClick={leave} className="btn btn-danger px-2.5 py-1.5 text-sm sm:px-3">
            Leave
          </button>
          <ShareBar roomId={state.roomId} />
        </div>
      </header>

      {state.youStatus === 'pending' && (
        <div className="rounded-xl bg-brass/15 px-4 py-2 text-center text-sm text-brass-bright ring-1 ring-brass/25">
          Waiting for the host to approve you…
        </div>
      )}
      {error && (
        <div className="rounded-xl bg-crimson/20 px-4 py-2 text-center text-sm text-crimson ring-1 ring-crimson/30">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <main className="flex min-h-0 flex-1 flex-col gap-2">
          <ResultBanner state={state} />
          <Table state={state} />
          {/* Bottom prompts: each child styles itself as a w-fit floating pill so
              nothing stretches across the screen. The strip itself is just a flex
              column for spacing — no background, no border. */}
          <div className="relative z-10 flex shrink-0 flex-col items-center gap-2">
            {state.youNote && (
              <div className="w-fit rounded-2xl bg-emerald-500/15 px-4 py-1.5 text-center text-sm text-emerald-200 ring-1 ring-emerald-400/25 backdrop-blur-sm">
                {state.youNote}
              </div>
            )}
            <ChooseTray key={state.game.handNumber} state={state} />
            {((state.game.awaitingSelection && !state.youMustSelect) ||
              (state.game.awaitingDiscard && !state.youMustDiscard)) && (
              <div className="flex w-fit items-center gap-3 rounded-full bg-black/45 px-3 py-1 text-sm text-ink-dim ring-1 ring-brass/20 backdrop-blur-sm">
                {state.game.awaitingDiscard ? 'Waiting for players to discard…' : 'Waiting for players to choose…'}
                {state.youAreHost && (
                  <button onClick={() => api.forceShowdown()} className="btn btn-ghost px-3 py-1 text-xs">
                    {state.game.awaitingDiscard ? 'Force discard' : 'Reveal now'}
                  </button>
                )}
              </div>
            )}
            <ShowHandControls state={state} />
            <TableStatus state={state} onOpenPicker={() => setShowVariants(true)} />
          </div>
        </main>

        {/* Right rail: betting actions (always) + host controls (host only). On
            screens below lg this whole rail wraps under main, so the action panel
            still ends up at the bottom of the screen instead of competing for
            horizontal room next to the table. Both children share identical width
            + padding so they read as a single cohesive sidebar. */}
        <aside className="flex w-full min-h-0 shrink-0 flex-col gap-3 lg:w-96">
          <div className="panel w-full shrink-0 rounded-2xl p-3 sm:p-4">
            <ActionBar state={state} onAct={(a) => api.act(a)} />
          </div>
          {state.youAreHost && <HostPanel state={state} />}
        </aside>
      </div>

      {showLedger && <Ledger state={state} onClose={() => setShowLedger(false)} />}
      {showSettle && <SettleUp state={state} onClose={() => setShowSettle(false)} />}
      {showVariants && (
        <VariantPicker
          current={state.settings.variant}
          onPick={(v) => api.setVariant(v)}
          onClose={() => setShowVariants(false)}
          // While the server is waiting on the dealer, the modal is non-dismissable —
          // picking IS the deal action, so there's no "close without choosing" path.
          dismissable={!state.awaitingDealerPick || !state.youAreDealer}
          subtitle={
            state.awaitingDealerPick && state.youAreDealer
              ? "It's your deal, choosing locks in the variant and deals the hand."
              : undefined
          }
        />
      )}
      {showTripleNine && <TripleNinePicker onConfirm={(n) => api.setTripleNineNumber(n)} />}
    </div>
  );
}
