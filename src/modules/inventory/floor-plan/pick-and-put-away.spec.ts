import { planPick, RackStock } from './pick-plan';
import { PutAwayLocation, suggestPutAway } from './put-away';

const stock = (
  locationId: string,
  quantity: number,
  extra: Partial<RackStock> = {},
): RackStock => ({
  locationId,
  quantity,
  code: locationId.toUpperCase(),
  isPickable: true,
  pickSequence: 0,
  ...extra,
});

describe('planPick', () => {
  it('takes the default location first', () => {
    const { legs } = planPick({ defaultLocationId: 'b' }, 3, [
      stock('a', 10, { pickSequence: 1 }),
      stock('b', 10, { pickSequence: 2 }),
    ]);
    expect(legs).toEqual([{ locationId: 'b', quantity: 3 }]);
  });

  it('prefers pickable locations, then the smaller pile, then walk order', () => {
    const { legs } = planPick({ defaultLocationId: null }, 9, [
      stock('dock', 1, { isPickable: false, pickSequence: 0 }),
      stock('a2', 5, { pickSequence: 2 }),
      stock('a1', 5, { pickSequence: 1 }),
      stock('small', 2, { pickSequence: 9 }),
    ]);
    expect(legs).toEqual([
      { locationId: 'small', quantity: 2 },
      { locationId: 'a1', quantity: 5 },
      { locationId: 'a2', quantity: 2 },
    ]);
  });

  it('breaks sequence ties by code', () => {
    const { legs } = planPick({ defaultLocationId: null }, 2, [
      stock('b', 1, { code: 'B' }),
      stock('a', 1, { code: 'A' }),
    ]);
    expect(legs.map((l) => l.locationId)).toEqual(['a', 'b']);
  });

  it('reports a shortfall instead of throwing', () => {
    expect(planPick({ defaultLocationId: null }, 7, [stock('a', 5)])).toEqual({
      legs: [{ locationId: 'a', quantity: 5 }],
      shortfall: 2,
    });
  });

  it('does not mutate its input', () => {
    const rows = [stock('b', 1, { code: 'B' }), stock('a', 1, { code: 'A' })];
    const before = JSON.stringify(rows);
    planPick({ defaultLocationId: null }, 2, rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe('suggestPutAway', () => {
  const loc = (
    id: string,
    extra: Partial<PutAwayLocation> = {},
  ): PutAwayLocation => ({
    id,
    code: id.toUpperCase(),
    type: 'BIN',
    isActive: true,
    isPickable: true,
    pickSequence: 0,
    isLeaf: true,
    zoneId: null,
    ...extra,
  });

  const ctx = (locations: PutAwayLocation[], occupied: string[] = []) => ({
    locations: new Map(locations.map((l) => [l.id, l])),
    occupied: new Set(occupied),
  });

  const dock = loc('dock', { type: 'RECEIVING', isPickable: false });

  it('1. uses the default location', () => {
    const c = ctx([
      dock,
      loc('a', { pickSequence: 1 }),
      loc('def', { pickSequence: 5 }),
    ]);
    expect(
      suggestPutAway(
        { sourceLocationId: 'dock', defaultLocationId: 'def', heldAt: [] },
        c,
      ),
    ).toBe('def');
  });

  it('skips a default that is inactive, not pickable, not a leaf or the source', () => {
    for (const bad of [
      loc('def', { isActive: false }),
      loc('def', { isPickable: false }),
      loc('def', { isLeaf: false }),
    ]) {
      const c = ctx([dock, bad, loc('a', { pickSequence: 1 })]);
      expect(
        suggestPutAway(
          { sourceLocationId: 'dock', defaultLocationId: 'def', heldAt: [] },
          c,
        ),
      ).toBe('a');
    }
    const c = ctx([loc('def'), loc('a', { pickSequence: 1 })]);
    expect(
      suggestPutAway(
        { sourceLocationId: 'def', defaultLocationId: 'def', heldAt: [] },
        c,
      ),
    ).toBe('a');
  });

  it('2. uses a location already holding the variant, in walk order', () => {
    const c = ctx(
      [
        dock,
        loc('empty', { pickSequence: 1 }),
        loc('h2', { pickSequence: 3 }),
        loc('h1', { pickSequence: 2 }),
      ],
      ['h1', 'h2', 'dock'],
    );
    expect(
      suggestPutAway(
        {
          sourceLocationId: 'dock',
          defaultLocationId: null,
          heldAt: ['dock', 'h2', 'h1'],
        },
        c,
      ),
    ).toBe('h1');
  });

  it("3. picks the first empty location, preferring the variant's zone", () => {
    const c = ctx(
      [
        dock,
        loc('z1-full', { zoneId: 'z1', isPickable: false, pickSequence: 1 }),
        loc('z2-empty', { zoneId: 'z2', pickSequence: 2 }),
        loc('z1-empty', { zoneId: 'z1', pickSequence: 3 }),
      ],
      ['z1-full'],
    );
    // Held at a non-pickable location in zone z1 → prefer z1.
    expect(
      suggestPutAway(
        {
          sourceLocationId: 'dock',
          defaultLocationId: null,
          heldAt: ['z1-full'],
        },
        c,
      ),
    ).toBe('z1-empty');
    // No zone preference → first empty by walk order.
    expect(
      suggestPutAway(
        { sourceLocationId: 'dock', defaultLocationId: null, heldAt: [] },
        c,
      ),
    ).toBe('z2-empty');
  });

  it('never suggests receiving / staging / zones', () => {
    const c = ctx([
      dock,
      loc('stage', { type: 'STAGING' }),
      loc('zone', { type: 'ZONE' }),
    ]);
    expect(
      suggestPutAway(
        { sourceLocationId: 'dock', defaultLocationId: 'stage', heldAt: [] },
        c,
      ),
    ).toBeNull();
  });

  it('4. returns null when nothing is free', () => {
    const c = ctx([dock, loc('a')], ['a']);
    expect(
      suggestPutAway(
        { sourceLocationId: 'dock', defaultLocationId: null, heldAt: [] },
        c,
      ),
    ).toBeNull();
  });
});
