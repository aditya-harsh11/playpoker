import { describe, it, expect } from 'vitest';
import { Room } from '../src/rooms/room';
import { serializeRoom, deserializeRoom } from '../src/rooms/serialize';

const settings = { variant: 'texas' as const, smallBlind: 5, bigBlind: 10, startingStack: 1000, maxSeats: 8 };

function setupHand(variant: string): { room: Room; ids: string[] } {
  const room = new Room('r1', settings);
  const host = room.addHost('Host', 's1');
  const ids = [host.id];
  for (const name of ['Bob', 'Cat']) {
    const req = room.requestJoin(name, 1000, `s-${name}`);
    ids.push(room.approveJoin(req.requestId)!.id);
  }
  room.startHand();
  const dealer = room.nextDealerId()!;
  expect(room.setVariantAndDeal(dealer, variant).ok).toBe(true);
  return { room, ids };
}

/** Everyone calls/checks until the hand is over or paused. */
function playOut(room: Room): void {
  for (let i = 0; i < 50 && room.handInProgress(); i++) {
    const actor = room.game!.publicState().toAct;
    if (!actor) break;
    const acts = room.game!.availableActionsFor(actor)!;
    room.applyPlayerAction(actor, acts.canCheck ? { type: 'check' } : { type: 'call' });
  }
}

describe('room save/load', () => {
  it('a restored mid-hand table plays out exactly like the original', () => {
    const { room, ids } = setupHand('texas');
    const first = room.game!.publicState().toAct!;
    room.applyPlayerAction(first, { type: 'call' });

    const copy = deserializeRoom(serializeRoom(room));
    expect(copy).toBeInstanceOf(Room);

    playOut(room);
    playOut(copy);

    for (const id of ids) {
      expect(copy.snapshotFor(id)).toEqual(room.snapshotFor(id));
    }
    expect(room.game!.isComplete()).toBe(true);
  });

  it('the restored game still mutates the room players', () => {
    const { room } = setupHand('texas');
    const copy = deserializeRoom(serializeRoom(room));
    const actor = copy.game!.publicState().toAct!;
    copy.applyPlayerAction(actor, { type: 'fold' });
    expect(copy.getPlayer(actor)!.status).toBe('folded');
  });

  it('keeps Maps and Sets through a manual-select showdown', () => {
    const { room, ids } = setupHand('plo');
    playOut(room);
    expect(room.game!.awaitingSelection).toBe(true);
    room.selectCards(ids[0], [0, 1]);

    const copy = deserializeRoom(serializeRoom(room));
    expect(copy.game!.hasSelected(ids[0])).toBe(true);
    for (const id of ids.slice(1)) {
      room.selectCards(id, [0, 1]);
      copy.selectCards(id, [0, 1]);
    }
    expect(copy.game!.lastResult).toEqual(room.game!.lastResult);
  });
});
