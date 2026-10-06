import {
  boundingBox,
  Box,
  fitsFloor,
  findFreeSpot,
  nudgeToFree,
  overlaps,
  pickFace,
  Placement,
  rotate,
  Rotation,
  slotRect,
  stopPoint,
} from './geometry';

// A 4 m × 1.2 m rack centred at (10, 10).
const rack = (rotation: Rotation = 0): Placement => ({
  centerX: 10,
  centerY: 10,
  length: 4,
  depth: 1.2,
  rotation,
});
const floor = { width: 20, depth: 20 };

describe('geometry', () => {
  describe('boundingBox', () => {
    it.each([
      [0, { x: 9.4, y: 8, width: 1.2, height: 4 }],
      [90, { x: 8, y: 9.4, width: 4, height: 1.2 }],
      [180, { x: 9.4, y: 8, width: 1.2, height: 4 }],
      [270, { x: 8, y: 9.4, width: 4, height: 1.2 }],
    ] as [Rotation, Box][])('rotation %i', (rotation, box) => {
      expect(boundingBox(rack(rotation))).toEqual(box);
    });

    it('areas use length as west-east regardless of rotation', () => {
      expect(
        boundingBox(
          { centerX: 5, centerY: 3, length: 10, depth: 6, rotation: 0 },
          'area',
        ),
      ).toEqual({ x: 0, y: 0, width: 10, height: 6 });
    });
  });

  describe('pickFace', () => {
    it.each([
      [0, 'east'],
      [90, 'south'],
      [180, 'west'],
      [270, 'north'],
    ] as const)('rotation %i faces %s', (rotation, face) => {
      expect(pickFace(rotation)).toBe(face);
    });
  });

  describe('slotRect', () => {
    // Inner box is inset by 0.2 m; 2 slots split the 3.6 m inner length.
    it('rotation 0: slot A at the north end', () => {
      expect(slotRect(rack(0), 0, 2)).toEqual({
        x: 9.6,
        y: 8.2,
        width: 0.8,
        height: 1.8,
      });
      expect(slotRect(rack(0), 1, 2).y).toBe(10);
    });

    it('rotation 90: slot A at the east end', () => {
      expect(slotRect(rack(90), 0, 2)).toEqual({
        x: 10,
        y: 9.6,
        width: 1.8,
        height: 0.8,
      });
      expect(slotRect(rack(90), 1, 2).x).toBe(8.2);
    });

    it('rotation 180: slot A at the south end', () => {
      expect(slotRect(rack(180), 0, 2).y).toBe(10);
      expect(slotRect(rack(180), 1, 2).y).toBe(8.2);
    });

    it('rotation 270: slot A at the west end', () => {
      expect(slotRect(rack(270), 0, 2).x).toBe(8.2);
      expect(slotRect(rack(270), 1, 2).x).toBe(10);
    });

    it('rejects a slot outside the rack', () => {
      expect(() => slotRect(rack(), 2, 2)).toThrow(RangeError);
    });
  });

  describe('stopPoint', () => {
    it.each([
      [0, { x: 11.35, y: 9.1 }], // east of the rack, level with slot A
      [90, { x: 10.9, y: 11.35 }], // south
      [180, { x: 8.65, y: 10.9 }], // west; slot A is the south end
      [270, { x: 9.1, y: 8.65 }], // north
    ] as [Rotation, { x: number; y: number }][])(
      'rotation %i stands 0.75 m outside the pick face',
      (rotation, point) => {
        expect(stopPoint(rack(rotation), 0, 2, floor)).toEqual(point);
      },
    );

    it('clamps inside the floor', () => {
      // Rack against the east wall, facing east.
      const atWall: Placement = { ...rack(0), centerX: 19.4 };
      expect(stopPoint(atWall, 0, 1, floor).x).toBe(20);
      // Rack against the north wall, facing north.
      const north: Placement = { ...rack(270), centerY: 0.6 };
      expect(stopPoint(north, 0, 1, floor).y).toBe(0);
    });

    it('is unclamped without a floor size', () => {
      const atWall: Placement = { ...rack(0), centerX: 19.4 };
      expect(stopPoint(atWall, 0, 1).x).toBe(20.75);
    });
  });

  describe('rotate', () => {
    it('keeps the centre and only changes rotation', () => {
      expect(rotate(rack(0), 'cw')).toEqual(rack(90));
      expect(rotate(rack(270), 'cw')).toEqual(rack(0));
      expect(rotate(rack(0), 'ccw')).toEqual(rack(270));
      expect(rotate(rack(90), '180')).toEqual(rack(270));
    });

    it('four cw turns return the original', () => {
      let p = rack(90);
      for (let i = 0; i < 4; i++) p = rotate(p, 'cw');
      expect(p).toEqual(rack(90));
    });

    it('ccw undoes cw', () => {
      for (const r of [0, 90, 180, 270] as Rotation[]) {
        expect(rotate(rotate(rack(r), 'cw'), 'ccw')).toEqual(rack(r));
      }
    });
  });

  describe('overlaps', () => {
    const a: Box = { x: 0, y: 0, width: 2, height: 2 };

    it('detects real overlap', () => {
      expect(overlaps(a, { x: 1, y: 1, width: 2, height: 2 })).toBe(true);
    });

    it('treats a gap below the clearance as a collision', () => {
      expect(overlaps(a, { x: 2.3, y: 0, width: 2, height: 2 })).toBe(true);
    });

    it('allows a gap of exactly the clearance', () => {
      expect(overlaps(a, { x: 2.5, y: 0, width: 2, height: 2 })).toBe(false);
    });

    it('allows diagonal neighbours outside the clearance', () => {
      expect(overlaps(a, { x: 2.6, y: 2.6, width: 1, height: 1 })).toBe(false);
    });

    it('takes a custom clearance', () => {
      expect(overlaps(a, { x: 2.3, y: 0, width: 2, height: 2 }, 0)).toBe(false);
    });
  });

  describe('fitsFloor', () => {
    it('accepts a box touching the walls', () => {
      expect(fitsFloor({ x: 0, y: 0, width: 20, height: 20 }, floor)).toBe(
        true,
      );
    });

    it('rejects a box past a wall', () => {
      expect(fitsFloor({ x: 19, y: 0, width: 1.2, height: 4 }, floor)).toBe(
        false,
      );
      expect(fitsFloor({ x: -0.1, y: 0, width: 1, height: 1 }, floor)).toBe(
        false,
      );
    });
  });

  describe('findFreeSpot', () => {
    const size = { length: 4, depth: 1.2, rotation: 0 as Rotation };

    it('takes the north-west corner of an empty floor', () => {
      expect(findFreeSpot(size, floor, [])).toEqual({
        ...size,
        centerX: 0.6,
        centerY: 2,
      });
    });

    it('scans along the row before moving south', () => {
      const blocker: Box = { x: 0, y: 0, width: 1.2, height: 4 };
      // Next column clear of the blocker + 0.5 m: x = 1.7 → snapped to 2.0.
      expect(findFreeSpot(size, floor, [blocker])).toMatchObject({
        centerX: 2.6,
        centerY: 2,
      });
    });

    it('stays inside `within`', () => {
      const zone: Box = { x: 10, y: 10, width: 5, height: 5 };
      const spot = findFreeSpot(size, floor, [], zone)!;
      expect(spot).toMatchObject({ centerX: 10.6, centerY: 12 });
    });

    it('returns null when nothing fits', () => {
      const full: Box = { x: 0, y: 0, width: 20, height: 20 };
      expect(findFreeSpot(size, floor, [full])).toBeNull();
      expect(
        findFreeSpot(size, floor, [], { x: 0, y: 0, width: 1, height: 1 }),
      ).toBeNull();
    });
  });

  describe('nudgeToFree', () => {
    it('keeps a placement that is already free', () => {
      expect(nudgeToFree(rack(), floor, [])).toEqual(rack());
    });

    it('moves to the nearest free spot', () => {
      // Obstacle just east of the rack; the rack must move west.
      const obstacle: Box = { x: 10.7, y: 6, width: 1, height: 8 };
      const moved = nudgeToFree(rack(), floor, [obstacle])!;
      expect(moved.rotation).toBe(0);
      expect(moved.centerY).toBe(10);
      expect(moved.centerX).toBe(9.5);
      expect(overlaps(boundingBox(moved), obstacle)).toBe(false);
    });

    it('pulls a placement back inside the floor', () => {
      const outside: Placement = { ...rack(), centerX: 19.8 };
      expect(nudgeToFree(outside, floor, [])).toMatchObject({
        centerX: 19.3,
        centerY: 10,
      });
    });

    it('gives up beyond maxDistance', () => {
      const wall: Box = { x: 0, y: 0, width: 20, height: 20 };
      expect(nudgeToFree(rack(), floor, [wall])).toBeNull();
      const obstacle: Box = { x: 4, y: 4, width: 12, height: 12 };
      expect(nudgeToFree(rack(), floor, [obstacle], 1)).toBeNull();
    });
  });
});
