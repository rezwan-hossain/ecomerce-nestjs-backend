/**
 * Rack codes, sequence numbers and the normalised rack structure
 * (levels × bins). Pure functions.
 */
import type { LocationType } from 'src/generated/prisma/enums';

export const RACK_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,9}$/;
export const SLOT_LETTERS = 'ABCDEF';
export const MAX_LEVELS = 8;
export const MAX_BINS_PER_LEVEL = SLOT_LETTERS.length;
export const DEFAULT_RACK_DEPTH = 1.2;
export const BIN_LENGTH = 1.4;
/** pickSequence values at or above this are reserved (docks, UNASSIGNED). */
export const RESERVED_SEQUENCE_FROM = 9000;

/** The existing code that `code` collides with, or null. */
export function rackCodeConflict(
  code: string,
  existingCodes: Iterable<string>,
): string | null {
  for (const existing of existingCodes) {
    if (existing === code || existing.startsWith(`${code}-`)) return existing;
  }
  return null;
}

/**
 * Start of the next free block of 100 pickSequence values: the highest
 * sequence below RESERVED_SEQUENCE_FROM, rounded up to the next 100.
 */
export function nextPickBlock(sequences: Iterable<number>): number {
  let max = 0;
  for (const s of sequences) {
    if (s < RESERVED_SEQUENCE_FROM && s > max) max = s;
  }
  return (Math.floor(max / 100) + 1) * 100;
}

export interface RackPlan {
  code: string;
  pickSequence: number;
  shelves: {
    code: string;
    levelNumber: number;
    pickSequence: number;
    bins: { code: string; slotIndex: number; pickSequence: number }[];
  }[];
}

/** RACK `code`, SHELF `${code}-L${n}`, BIN `${code}-${n}-${A..F}`. */
export function buildRackPlan(
  code: string,
  levels: number,
  binsPerLevel: number,
  block: number,
): RackPlan {
  if (levels < 1 || levels > MAX_LEVELS) {
    throw new RangeError(`levels must be 1..${MAX_LEVELS}`);
  }
  if (binsPerLevel < 1 || binsPerLevel > MAX_BINS_PER_LEVEL) {
    throw new RangeError(`binsPerLevel must be 1..${MAX_BINS_PER_LEVEL}`);
  }
  return {
    code,
    pickSequence: block,
    shelves: Array.from({ length: levels }, (_, l) => {
      const n = l + 1;
      return {
        code: `${code}-L${n}`,
        levelNumber: n,
        pickSequence: block + n * 10,
        bins: Array.from({ length: binsPerLevel }, (_, i) => ({
          code: `${code}-${n}-${SLOT_LETTERS[i]}`,
          slotIndex: i,
          pickSequence: block + n * 10 + i + 1,
        })),
      };
    }),
  };
}

// ─── Normalised structure ─────────────────────────────────────

export interface StructureNode {
  id: string;
  code: string;
  type: LocationType;
  parentId: string | null;
  isActive: boolean;
  isPickable: boolean;
  pickSequence: number;
  levelNumber: number | null;
  slotIndex: number | null;
}

export interface RackBin {
  id: string;
  code: string;
  slotIndex: number;
  isActive: boolean;
  isPickable: boolean;
}

export interface RackLevel {
  id: string;
  levelNumber: number;
  bins: RackBin[];
}

export interface RackStructure {
  levels: RackLevel[]; // ground level first
  slotCount: number; // slot columns: the most bins on a level (or highest slot + 1)
}

const walkOrder = (
  a: Pick<StructureNode, 'code' | 'pickSequence'>,
  b: Pick<StructureNode, 'code' | 'pickSequence'>,
) => a.pickSequence - b.pickSequence || a.code.localeCompare(b.code);

/**
 * Numbers siblings: rows keep a stored number; the rest, in walk order
 * (pickSequence, code), take the lowest unused numbers from `first`. Shared
 * by the map and the backfill script so both agree.
 */
export function numbered<
  T extends Pick<StructureNode, 'code' | 'pickSequence'>,
>(
  nodes: readonly T[],
  stored: (n: T) => number | null,
  first: number,
): { node: T; number: number }[] {
  const sorted = [...nodes].sort(
    (a, b) =>
      (stored(a) ?? Infinity) - (stored(b) ?? Infinity) || walkOrder(a, b),
  );
  const used = new Set(
    sorted.map(stored).filter((n): n is number => n !== null),
  );
  let next = first;
  return sorted
    .map((node) => {
      let number = stored(node);
      if (number === null) {
        while (used.has(next)) next++;
        number = next++;
        used.add(number);
      }
      return { node, number };
    })
    .sort((a, b) => a.number - b.number);
}

const toBin = (node: StructureNode, slotIndex: number): RackBin => ({
  id: node.id,
  code: node.code,
  slotIndex,
  isActive: node.isActive,
  isPickable: node.isPickable,
});

/**
 * Levels and bins of a rack:
 * - SHELF children → one level each (by levelNumber, else walk order); each
 *   shelf's children are its bins (by slotIndex, else walk order), and a
 *   shelf without bins is a single-bin level using the shelf itself;
 * - only BIN children → one level;
 * - no children → one level whose only bin is the rack itself.
 */
export function normalizeRack(
  rack: StructureNode,
  childrenOf: (id: string) => readonly StructureNode[],
): RackStructure {
  const children = childrenOf(rack.id);
  const shelves = children.filter((c) => c.type === 'SHELF');

  const binsOf = (parent: StructureNode): RackBin[] => {
    const kids = childrenOf(parent.id);
    if (!kids.length) return [toBin(parent, 0)];
    return numbered(kids, (k) => k.slotIndex, 0).map(({ node, number }) =>
      toBin(node, number),
    );
  };

  let levels: RackLevel[];
  if (shelves.length) {
    levels = numbered(shelves, (s) => s.levelNumber, 1).map(
      ({ node, number }) => ({
        id: node.id,
        levelNumber: number,
        bins: binsOf(node),
      }),
    );
  } else {
    levels = [{ id: rack.id, levelNumber: 1, bins: binsOf(rack) }];
  }

  // Stored slot indexes can have gaps (bins removed), so a column exists for
  // every index in use, not just for each bin.
  const slotCount = Math.max(
    ...levels.flatMap((l) => [
      l.bins.length,
      ...l.bins.map((b) => b.slotIndex + 1),
    ]),
  );
  return { levels, slotCount };
}
