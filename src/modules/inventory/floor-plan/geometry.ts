/**
 * Floor-plan geometry. Pure functions, no framework or database.
 *
 * Units are metres. The origin is the north-west corner of the floor; x grows
 * east and y grows south. Rotation is clockwise, north up.
 *
 * A rack's `length` runs along its slots (A → B → C) and `depth` across it:
 *
 *   rotation | box width × height | pick face | slot A at
 *   ---------+--------------------+-----------+-----------
 *        0   | depth × length     | east      | north end
 *       90   | length × depth     | south     | east end
 *      180   | depth × length     | west      | south end
 *      270   | length × depth     | north     | west end
 *
 * Areas (zones, aisles) are always rotation 0 with `length` west-east and
 * `depth` north-south, and have no pick face.
 */

export type Rotation = 0 | 90 | 180 | 270;
export type Face = 'north' | 'east' | 'south' | 'west';
export type RotateDirection = 'cw' | 'ccw' | '180';
/** `rack` = anything with slots and an orientation; `area` = zone / aisle. */
export type ShapeKind = 'rack' | 'area';

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number; // top-left (north-west) corner
  y: number;
  width: number; // west → east
  height: number; // north → south
}

export interface Placement {
  centerX: number;
  centerY: number;
  length: number;
  depth: number;
  rotation: Rotation;
}

export interface Floor {
  width: number;
  depth: number;
}

export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];
/** Minimum gap between racks, docks and staging areas. */
export const CLEARANCE = 0.5;
/** Gap between a rack's outline and its slot columns. */
export const SLOT_INSET = 0.2;
/** How far outside the pick face a picker stands. */
export const STOP_OFFSET = 0.75;

const EPS = 1e-9;

/** Rounds to centimetres, the precision the database stores (Decimal(8,2)). */
export const round2 = (n: number) => Math.round(n * 100) / 100;

export function isRotation(n: number): n is Rotation {
  return (ROTATIONS as readonly number[]).includes(n);
}

/** Width × height of the drawn box for a size and rotation. */
export function boxSize(
  p: Pick<Placement, 'length' | 'depth' | 'rotation'>,
  kind: ShapeKind = 'rack',
): { width: number; height: number } {
  if (kind === 'area') return { width: p.length, height: p.depth };
  return p.rotation === 0 || p.rotation === 180
    ? { width: p.depth, height: p.length }
    : { width: p.length, height: p.depth };
}

export function boundingBox(p: Placement, kind: ShapeKind = 'rack'): Box {
  const { width, height } = boxSize(p, kind);
  return {
    x: round2(p.centerX - width / 2),
    y: round2(p.centerY - height / 2),
    width,
    height,
  };
}

export function boxCenter(b: Box): Point {
  return { x: round2(b.x + b.width / 2), y: round2(b.y + b.height / 2) };
}

export function pickFace(rotation: Rotation): Face {
  const faces: Record<Rotation, Face> = {
    0: 'east',
    90: 'south',
    180: 'west',
    270: 'north',
  };
  return faces[rotation];
}

/**
 * The slot column for `slotIndex` (0 = A) inside a rack, inset by
 * SLOT_INSET, in the slot order of the rack's rotation.
 */
export function slotRect(
  p: Placement,
  slotIndex: number,
  slotCount: number,
): Box {
  if (slotCount < 1 || slotIndex < 0 || slotIndex >= slotCount) {
    throw new RangeError(`Slot ${slotIndex} is outside 0..${slotCount - 1}`);
  }
  const box = boundingBox(p);
  const inner: Box = {
    x: box.x + SLOT_INSET,
    y: box.y + SLOT_INSET,
    width: Math.max(0, box.width - 2 * SLOT_INSET),
    height: Math.max(0, box.height - 2 * SLOT_INSET),
  };

  // Slots run along y for 0/180 and along x for 90/270.
  const alongY = p.rotation === 0 || p.rotation === 180;
  const span = alongY ? inner.height : inner.width;
  const size = span / slotCount;
  // Index counted from the north (y) or west (x) edge of the inner box.
  const fromStart =
    p.rotation === 0 || p.rotation === 270
      ? slotIndex
      : slotCount - 1 - slotIndex;

  const rect: Box = alongY
    ? {
        x: inner.x,
        y: inner.y + fromStart * size,
        width: inner.width,
        height: size,
      }
    : {
        x: inner.x + fromStart * size,
        y: inner.y,
        width: size,
        height: inner.height,
      };
  return {
    x: round2(rect.x),
    y: round2(rect.y),
    width: round2(rect.width),
    height: round2(rect.height),
  };
}

/**
 * Where a picker stands for a slot: STOP_OFFSET outside the pick face, level
 * with the slot centre, clamped inside the floor (when the floor is known).
 */
export function stopPoint(
  p: Placement,
  slotIndex: number,
  slotCount: number,
  floor?: Floor | null,
): Point {
  const box = boundingBox(p);
  const slot = boxCenter(slotRect(p, slotIndex, slotCount));
  let point: Point;
  switch (pickFace(p.rotation)) {
    case 'east':
      point = { x: box.x + box.width + STOP_OFFSET, y: slot.y };
      break;
    case 'west':
      point = { x: box.x - STOP_OFFSET, y: slot.y };
      break;
    case 'south':
      point = { x: slot.x, y: box.y + box.height + STOP_OFFSET };
      break;
    case 'north':
      point = { x: slot.x, y: box.y - STOP_OFFSET };
      break;
  }
  if (floor) {
    point = {
      x: Math.min(Math.max(point.x, 0), floor.width),
      y: Math.min(Math.max(point.y, 0), floor.depth),
    };
  }
  return { x: round2(point.x), y: round2(point.y) };
}

/** Turns in place: the centre stays fixed, so four `cw` turns are a no-op. */
export function rotate(p: Placement, direction: RotateDirection): Placement {
  const turn = direction === 'cw' ? 90 : direction === 'ccw' ? 270 : 180;
  return { ...p, rotation: ((p.rotation + turn) % 360) as Rotation };
}

/** True when the boxes are closer than `clearance` (touching at exactly `clearance` is fine). */
export function overlaps(a: Box, b: Box, clearance = CLEARANCE): boolean {
  return (
    a.x < b.x + b.width + clearance - EPS &&
    b.x < a.x + a.width + clearance - EPS &&
    a.y < b.y + b.height + clearance - EPS &&
    b.y < a.y + a.height + clearance - EPS
  );
}

export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.width <= outer.x + outer.width + EPS &&
    inner.y + inner.height <= outer.y + outer.height + EPS
  );
}

export function fitsFloor(box: Box, floor: Floor): boolean {
  return contains({ x: 0, y: 0, width: floor.width, height: floor.depth }, box);
}

/** Whether a rack-like placement fits the floor and clears every obstacle. */
export function isFree(
  p: Placement,
  floor: Floor,
  obstacles: readonly Box[],
  clearance = CLEARANCE,
): boolean {
  const box = boundingBox(p);
  return (
    fitsFloor(box, floor) && !obstacles.some((o) => overlaps(box, o, clearance))
  );
}

/**
 * First free spot for a rack of `size`, scanning row by row (north → south),
 * each row west → east, in `step` increments. With `within`, only spots
 * fully inside that box (e.g. a zone) are considered.
 */
export function findFreeSpot(
  size: Pick<Placement, 'length' | 'depth' | 'rotation'>,
  floor: Floor,
  obstacles: readonly Box[],
  within?: Box,
  step = 0.5,
  clearance = CLEARANCE,
): Placement | null {
  const { width, height } = boxSize(size);
  const region: Box = within ?? {
    x: 0,
    y: 0,
    width: floor.width,
    height: floor.depth,
  };
  const cols = Math.floor((region.width - width) / step + EPS);
  const rows = Math.floor((region.height - height) / step + EPS);

  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const candidate: Placement = {
        ...size,
        centerX: round2(region.x + c * step + width / 2),
        centerY: round2(region.y + r * step + height / 2),
      };
      const box = boundingBox(candidate);
      if (within && !contains(within, box)) continue;
      if (isFree(candidate, floor, obstacles, clearance)) return candidate;
    }
  }
  return null;
}

/**
 * The original spot if it's free, else the nearest free spot on a `step`
 * grid around it, by straight-line distance up to `maxDistance`. Ties go
 * north before south, then west before east, so results are stable.
 */
export function nudgeToFree(
  p: Placement,
  floor: Floor,
  obstacles: readonly Box[],
  maxDistance = 4,
  step = 0.5,
  clearance = CLEARANCE,
): Placement | null {
  if (isFree(p, floor, obstacles, clearance)) return p;

  // Every grid offset within reach, nearest first.
  const reach = Math.floor(maxDistance / step + EPS);
  const offsets: { dx: number; dy: number; dist: number }[] = [];
  for (let i = -reach; i <= reach; i++) {
    for (let j = -reach; j <= reach; j++) {
      const dx = i * step;
      const dy = j * step;
      const dist = Math.hypot(dx, dy);
      if (dist > 0 && dist <= maxDistance + EPS) offsets.push({ dx, dy, dist });
    }
  }
  offsets.sort((a, b) => a.dist - b.dist || a.dy - b.dy || a.dx - b.dx);

  for (const { dx, dy } of offsets) {
    const candidate: Placement = {
      ...p,
      centerX: round2(p.centerX + dx),
      centerY: round2(p.centerY + dy),
    };
    if (isFree(candidate, floor, obstacles, clearance)) return candidate;
  }
  return null;
}
