import {
  buildRackPlan,
  nextPickBlock,
  normalizeRack,
  rackCodeConflict,
  RACK_CODE_PATTERN,
  StructureNode,
} from './rack-layout';

describe('rack codes', () => {
  it.each(['A', 'B-04', 'R12', 'ZONE1-RACK'])('accepts %s', (code) => {
    expect(RACK_CODE_PATTERN.test(code)).toBe(true);
  });

  it.each(['', '-A', 'a-01', 'ABCDEFGHIJK', 'A_1', 'A 1'])(
    'rejects "%s"',
    (code) => {
      expect(RACK_CODE_PATTERN.test(code)).toBe(false);
    },
  );

  it('conflicts with an equal code or one under its prefix', () => {
    expect(rackCodeConflict('B', ['A-01', 'B'])).toBe('B');
    expect(rackCodeConflict('B', ['A-01', 'B-1-A'])).toBe('B-1-A');
    expect(rackCodeConflict('B', ['BB', 'B1', 'A-B'])).toBeNull();
  });
});

describe('nextPickBlock', () => {
  it('rounds the highest sequence below 9000 up to the next 100', () => {
    expect(nextPickBlock([1, 14, 211, 999999, 9000])).toBe(300);
    expect(nextPickBlock([300])).toBe(400);
    expect(nextPickBlock([900])).toBe(1000);
  });

  it('starts at 100 for an empty warehouse', () => {
    expect(nextPickBlock([])).toBe(100);
    expect(nextPickBlock([999999])).toBe(100);
  });
});

describe('buildRackPlan', () => {
  it('builds shelf and bin codes, levels, slots and sequences', () => {
    const plan = buildRackPlan('B', 2, 3, 500);
    expect(plan.pickSequence).toBe(500);
    expect(plan.shelves).toEqual([
      {
        code: 'B-L1',
        levelNumber: 1,
        pickSequence: 510,
        bins: [
          { code: 'B-1-A', slotIndex: 0, pickSequence: 511 },
          { code: 'B-1-B', slotIndex: 1, pickSequence: 512 },
          { code: 'B-1-C', slotIndex: 2, pickSequence: 513 },
        ],
      },
      {
        code: 'B-L2',
        levelNumber: 2,
        pickSequence: 520,
        bins: [
          { code: 'B-2-A', slotIndex: 0, pickSequence: 521 },
          { code: 'B-2-B', slotIndex: 1, pickSequence: 522 },
          { code: 'B-2-C', slotIndex: 2, pickSequence: 523 },
        ],
      },
    ]);
  });

  it('keeps the largest rack inside its block of 100', () => {
    const plan = buildRackPlan('R', 8, 6, 100);
    const last = plan.shelves[7].bins[5];
    expect(last).toEqual({ code: 'R-8-F', slotIndex: 5, pickSequence: 186 });
  });

  it('rejects out-of-range sizes', () => {
    expect(() => buildRackPlan('R', 9, 1, 100)).toThrow(RangeError);
    expect(() => buildRackPlan('R', 1, 7, 100)).toThrow(RangeError);
  });
});

describe('normalizeRack', () => {
  const node = (
    id: string,
    type: StructureNode['type'],
    parentId: string | null,
    extra: Partial<StructureNode> = {},
  ): StructureNode => ({
    id,
    code: id.toUpperCase(),
    type,
    parentId,
    isActive: true,
    isPickable: true,
    pickSequence: 0,
    levelNumber: null,
    slotIndex: null,
    ...extra,
  });

  const tree = (nodes: StructureNode[]) => (id: string) =>
    nodes.filter((n) => n.parentId === id);

  it('shelves become levels and their bins become slots', () => {
    const rack = node('r', 'RACK', null);
    const nodes = [
      node('l2', 'SHELF', 'r', { levelNumber: 2 }),
      node('l1', 'SHELF', 'r', { levelNumber: 1 }),
      node('l1b', 'BIN', 'l1', { slotIndex: 1 }),
      node('l1a', 'BIN', 'l1', { slotIndex: 0 }),
      node('l2a', 'BIN', 'l2', { slotIndex: 0 }),
    ];
    const s = normalizeRack(rack, tree(nodes));
    expect(s.slotCount).toBe(2);
    expect(
      s.levels.map((l) => [l.levelNumber, l.bins.map((b) => b.id)]),
    ).toEqual([
      [1, ['l1a', 'l1b']],
      [2, ['l2a']],
    ]);
  });

  it('falls back to walk order when numbers are missing', () => {
    const rack = node('r', 'RACK', null);
    const nodes = [
      node('top', 'SHELF', 'r', { pickSequence: 20 }),
      node('ground', 'SHELF', 'r', { pickSequence: 10 }),
    ];
    const s = normalizeRack(rack, tree(nodes));
    // Shelves without bins are single-bin levels using the shelf itself.
    expect(s.levels).toEqual([
      expect.objectContaining({
        id: 'ground',
        levelNumber: 1,
        bins: [expect.objectContaining({ id: 'ground', slotIndex: 0 })],
      }),
      expect.objectContaining({ id: 'top', levelNumber: 2 }),
    ]);
    expect(s.slotCount).toBe(1);
  });

  it('a rack with bins directly has one level', () => {
    const rack = node('r', 'RACK', null);
    const nodes = [
      node('b', 'BIN', 'r', { pickSequence: 2 }),
      node('a', 'BIN', 'r', { pickSequence: 1 }),
    ];
    const s = normalizeRack(rack, tree(nodes));
    expect(s.levels).toEqual([
      {
        id: 'r',
        levelNumber: 1,
        bins: [
          expect.objectContaining({ id: 'a', slotIndex: 0 }),
          expect.objectContaining({ id: 'b', slotIndex: 1 }),
        ],
      },
    ]);
  });

  it('a rack without children is its own single bin', () => {
    const rack = node('r', 'RACK', null);
    expect(normalizeRack(rack, () => [])).toEqual({
      levels: [
        {
          id: 'r',
          levelNumber: 1,
          bins: [expect.objectContaining({ id: 'r', slotIndex: 0 })],
        },
      ],
      slotCount: 1,
    });
  });

  it('counts a column for every slot index in use', () => {
    const rack = node('r', 'RACK', null);
    const nodes = [node('c', 'BIN', 'r', { slotIndex: 2 })];
    expect(normalizeRack(rack, tree(nodes)).slotCount).toBe(3);
  });
});
