/**
 * Where stock sitting at a receiving / staging location should go. Pure:
 * the caller loads the warehouse's locations and stock once.
 */
import type { LocationType } from 'src/generated/prisma/enums';

/** Location types that can hold stored stock (put-away destinations). */
export const STORAGE_TYPES: readonly LocationType[] = ['RACK', 'SHELF', 'BIN'];
/** Location types whose stock is waiting to be put away. */
export const INBOUND_TYPES: readonly LocationType[] = ['RECEIVING', 'STAGING'];

export interface PutAwayLocation {
  id: string;
  code: string;
  type: LocationType;
  isActive: boolean;
  isPickable: boolean;
  pickSequence: number;
  isLeaf: boolean;
  zoneId: string | null; // nearest ZONE ancestor
}

export interface PutAwayContext {
  /** Every location of the warehouse by id. */
  locations: ReadonlyMap<string, PutAwayLocation>;
  /** Ids of locations holding any stock (of any variant). */
  occupied: ReadonlySet<string>;
}

export interface PutAwayLine {
  sourceLocationId: string;
  defaultLocationId: string | null;
  /** Other locations already holding this variant (same inventory level). */
  heldAt: readonly string[];
}

const byWalkOrder = (a: PutAwayLocation, b: PutAwayLocation) =>
  a.pickSequence - b.pickSequence || a.code.localeCompare(b.code);

/** An active, pickable storage leaf other than the source. */
export function isPutAwayTarget(
  loc: PutAwayLocation | undefined,
  sourceLocationId: string,
): loc is PutAwayLocation {
  return (
    !!loc &&
    loc.id !== sourceLocationId &&
    loc.isActive &&
    loc.isPickable &&
    loc.isLeaf &&
    STORAGE_TYPES.includes(loc.type)
  );
}

/**
 * 1. the level's default location;
 * 2. else a location already holding this variant (walk order);
 * 3. else the first empty location by walk order, preferring the zones the
 *    variant is already stored in;
 * 4. else null.
 */
export function suggestPutAway(
  line: PutAwayLine,
  ctx: PutAwayContext,
): string | null {
  const { sourceLocationId } = line;
  const target = (id: string | null) => {
    const loc = id ? ctx.locations.get(id) : undefined;
    return isPutAwayTarget(loc, sourceLocationId) ? loc : undefined;
  };

  const fallback = target(line.defaultLocationId);
  if (fallback) return fallback.id;

  const holding = line.heldAt
    .map(target)
    .filter((l): l is PutAwayLocation => !!l)
    .sort(byWalkOrder);
  if (holding.length) return holding[0].id;

  const zones = new Set(
    line.heldAt
      .map((id) => ctx.locations.get(id)?.zoneId)
      .filter((z): z is string => !!z),
  );
  const empty = [...ctx.locations.values()]
    .filter((l) => isPutAwayTarget(l, sourceLocationId))
    .filter((l) => !ctx.occupied.has(l.id))
    .sort(byWalkOrder);
  const sameZone = empty.find((l) => l.zoneId && zones.has(l.zoneId));
  return (sameZone ?? empty[0])?.id ?? null;
}
