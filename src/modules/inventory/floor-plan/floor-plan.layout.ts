/**
 * In-memory model of one warehouse's locations, built from a single
 * findMany: the tree, floor-level items and their placements, rack
 * structures, and per-location stock / activity aggregates. Shared by the
 * floor-plan, pick-route, put-away and rack endpoints so they all read the
 * layout the same way.
 */
import { Decimal } from '@prisma/client/runtime/client';
import type { LocationType } from 'src/generated/prisma/enums';
import {
  boundingBox,
  Box,
  Floor,
  isRotation,
  Placement,
  ShapeKind,
} from './geometry';
import { normalizeRack, RackStructure, StructureNode } from './rack-layout';

/** Location types that can sit on the floor plan. */
export const FLOOR_TYPES: readonly LocationType[] = [
  'ZONE',
  'AISLE',
  'RACK',
  'RECEIVING',
  'STAGING',
  'PACKING',
];
/** Floor types that are regions: other items may sit inside or over them. */
export const AREA_TYPES: readonly LocationType[] = ['ZONE', 'AISLE'];

export const shapeKind = (type: LocationType): ShapeKind =>
  AREA_TYPES.includes(type) ? 'area' : 'rack';

export interface LocationRow extends StructureNode {
  warehouseId: string;
  name: string | null;
  mapCenterX: Decimal | null;
  mapCenterY: Decimal | null;
  mapLength: Decimal | null;
  mapDepth: Decimal | null;
  mapRotation: number;
}

/** Prisma select for LocationRow. */
export const LOCATION_ROW_SELECT = {
  id: true,
  warehouseId: true,
  code: true,
  name: true,
  type: true,
  parentId: true,
  isActive: true,
  isPickable: true,
  pickSequence: true,
  levelNumber: true,
  slotIndex: true,
  mapCenterX: true,
  mapCenterY: true,
  mapLength: true,
  mapDepth: true,
  mapRotation: true,
} as const;

export function placementOf(row: LocationRow): Placement | null {
  if (
    row.mapCenterX === null ||
    row.mapCenterY === null ||
    row.mapLength === null ||
    row.mapDepth === null
  ) {
    return null;
  }
  return {
    centerX: Number(row.mapCenterX),
    centerY: Number(row.mapCenterY),
    length: Number(row.mapLength),
    depth: Number(row.mapDepth),
    rotation: isRotation(row.mapRotation) ? row.mapRotation : 0,
  };
}

export function floorOf(w: {
  floorWidth: Decimal | null;
  floorDepth: Decimal | null;
}): Floor | null {
  return w.floorWidth !== null && w.floorDepth !== null
    ? { width: Number(w.floorWidth), depth: Number(w.floorDepth) }
    : null;
}

export class WarehouseLayout {
  readonly byId = new Map<string, LocationRow>();
  private readonly children = new Map<string, LocationRow[]>();
  private readonly subtreeCache = new Map<string, string[]>();
  private readonly rackCache = new Map<string, RackStructure>();

  constructor(readonly locations: readonly LocationRow[]) {
    for (const loc of locations) {
      this.byId.set(loc.id, loc);
      if (loc.parentId) {
        const list = this.children.get(loc.parentId) ?? [];
        list.push(loc);
        this.children.set(loc.parentId, list);
      }
    }
  }

  childrenOf = (id: string): readonly LocationRow[] =>
    this.children.get(id) ?? [];

  isLeaf(id: string) {
    return this.childrenOf(id).length === 0;
  }

  /** The location and all its descendants. */
  subtree(id: string): string[] {
    const cached = this.subtreeCache.get(id);
    if (cached) return cached;
    const ids: string[] = [];
    const stack = [id];
    while (stack.length) {
      const current = stack.pop()!;
      ids.push(current);
      for (const child of this.childrenOf(current)) stack.push(child.id);
    }
    this.subtreeCache.set(id, ids);
    return ids;
  }

  /** Placeable type with no parent or a ZONE parent. */
  isFloorLevel(loc: LocationRow): boolean {
    if (!FLOOR_TYPES.includes(loc.type)) return false;
    if (!loc.parentId) return true;
    return this.byId.get(loc.parentId)?.type === 'ZONE';
  }

  floorItems(): LocationRow[] {
    return this.locations
      .filter((l) => this.isFloorLevel(l))
      .sort(
        (a, b) =>
          a.pickSequence - b.pickSequence || a.code.localeCompare(b.code),
      );
  }

  /** Nearest ancestor-or-self matching `test`. */
  ancestor(
    id: string,
    test: (loc: LocationRow) => boolean,
  ): LocationRow | undefined {
    let current = this.byId.get(id);
    for (let depth = 0; current && depth < 50; depth++) {
      if (test(current)) return current;
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    return undefined;
  }

  /** The floor-level item a location belongs to (itself, or its rack / zone). */
  floorItemOf(id: string): LocationRow | undefined {
    return this.ancestor(id, (l) => this.isFloorLevel(l));
  }

  rackStructure(rack: LocationRow): RackStructure {
    let s = this.rackCache.get(rack.id);
    if (!s) {
      s = normalizeRack(rack, this.childrenOf);
      this.rackCache.set(rack.id, s);
    }
    return s;
  }

  /** Bin → its rack and slot, for every rack. */
  binSlots(): Map<string, { rackId: string; slotIndex: number }> {
    const map = new Map<string, { rackId: string; slotIndex: number }>();
    for (const loc of this.locations) {
      if (loc.type !== 'RACK') continue;
      for (const level of this.rackStructure(loc).levels) {
        for (const bin of level.bins) {
          map.set(bin.id, { rackId: loc.id, slotIndex: bin.slotIndex });
        }
      }
    }
    return map;
  }

  /** Boxes of placed floor items that block racks (everything but areas). */
  obstacles(exceptId?: string): { id: string; code: string; box: Box }[] {
    const result: { id: string; code: string; box: Box }[] = [];
    for (const loc of this.floorItems()) {
      if (loc.id === exceptId || AREA_TYPES.includes(loc.type)) continue;
      const p = placementOf(loc);
      if (p) result.push({ id: loc.id, code: loc.code, box: boundingBox(p) });
    }
    return result;
  }
}

// ─── Stock & activity aggregates ──────────────────────────────

export interface StockRow {
  locationId: string;
  inventoryLevelId: string;
  variantId: string;
  sku: string;
  productName: string;
  defaultLocationId: string | null;
  quantity: number;
  unitCost: Decimal;
}

export interface MovementPair {
  fromLocationId: string | null;
  toLocationId: string | null;
  count: number;
}

export interface CellStats {
  units: number;
  value: string;
  skuCount: number;
  movements: number;
}

export interface TopSku {
  inventoryLevelId: string;
  variantId: string;
  sku: string;
  quantity: number;
}

export class StockIndex {
  private readonly rowsByLocation = new Map<string, StockRow[]>();
  private readonly touches = new Map<string, number>();

  constructor(
    rows: readonly StockRow[],
    private readonly pairs: readonly MovementPair[],
  ) {
    for (const row of rows) {
      const list = this.rowsByLocation.get(row.locationId) ?? [];
      list.push(row);
      this.rowsByLocation.set(row.locationId, list);
    }
    // Movements touching each location (a movement has at most one of
    // each end, and LOCATION_MOVE ends always differ).
    for (const p of pairs) {
      for (const id of [p.fromLocationId, p.toLocationId]) {
        if (id) this.touches.set(id, (this.touches.get(id) ?? 0) + p.count);
      }
    }
  }

  rowsAt(locationId: string): readonly StockRow[] {
    return this.rowsByLocation.get(locationId) ?? [];
  }

  unitsAt(locationId: string): number {
    return this.rowsAt(locationId).reduce((sum, r) => sum + r.quantity, 0);
  }

  stats(locationIds: readonly string[]): CellStats {
    const set = new Set(locationIds);
    let units = 0;
    let value = new Decimal(0);
    const skus = new Set<string>();
    let movements = 0;
    for (const id of set) {
      for (const row of this.rowsAt(id)) {
        units += row.quantity;
        value = value.plus(new Decimal(row.unitCost).mul(row.quantity));
        skus.add(row.variantId);
      }
      movements += this.touches.get(id) ?? 0;
    }
    // A move between two locations of the same set was counted twice.
    if (set.size > 1) {
      for (const p of this.pairs) {
        if (
          p.fromLocationId &&
          p.toLocationId &&
          set.has(p.fromLocationId) &&
          set.has(p.toLocationId)
        ) {
          movements -= p.count;
        }
      }
    }
    return { units, value: value.toFixed(2), skuCount: skus.size, movements };
  }

  topSkus(locationId: string, limit = 3): TopSku[] {
    return [...this.rowsAt(locationId)]
      .sort((a, b) => b.quantity - a.quantity || a.sku.localeCompare(b.sku))
      .slice(0, limit)
      .map(({ inventoryLevelId, variantId, sku, quantity }) => ({
        inventoryLevelId,
        variantId,
        sku,
        quantity,
      }));
  }
}
