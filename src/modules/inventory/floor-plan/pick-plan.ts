/**
 * Which racks a pick takes units from. Pure: the caller loads the rack
 * stock and applies the legs. Used by real picking (commit / sale and other
 * outbound movements) and by the pick-route endpoint, so the route on the
 * map is the route that actually gets picked.
 */

export interface RackStock {
  locationId: string;
  quantity: number;
  code: string;
  isPickable: boolean;
  pickSequence: number;
}

export interface PickLeg {
  locationId: string;
  quantity: number;
}

export interface PickPlan {
  legs: PickLeg[];
  /** Units the racks couldn't cover (0 when the plan is complete). */
  shortfall: number;
}

/**
 * Pick order: the variant's default rack first, then pickable racks before
 * non-pickable ones (receiving, UNASSIGNED), then the smaller pile first (so
 * overflow racks empty out), then walk order (pickSequence, code).
 * Doesn't mutate its inputs.
 */
export function planPick(
  level: { defaultLocationId: string | null },
  quantity: number,
  rackStocks: readonly RackStock[],
): PickPlan {
  const isDefault = (id: string) => (id === level.defaultLocationId ? 0 : 1);
  const ordered = rackStocks
    .filter((r) => r.quantity > 0)
    .sort(
      (a, b) =>
        isDefault(a.locationId) - isDefault(b.locationId) ||
        Number(b.isPickable) - Number(a.isPickable) ||
        a.quantity - b.quantity ||
        a.pickSequence - b.pickSequence ||
        a.code.localeCompare(b.code),
    );

  const legs: PickLeg[] = [];
  let remaining = quantity;
  for (const row of ordered) {
    if (remaining === 0) break;
    const take = Math.min(remaining, row.quantity);
    legs.push({ locationId: row.locationId, quantity: take });
    remaining -= take;
  }
  return { legs, shortfall: remaining };
}
