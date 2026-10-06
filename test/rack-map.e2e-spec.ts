/**
 * Rack map against the e2e database (see test/test-db.ts). Each run works in
 * its own warehouses and SKUs, so runs don't interfere.
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { FloorPlanService } from '../src/modules/inventory/floor-plan/floor-plan.service';

const RUN = randomUUID().slice(0, 6).toUpperCase();

// Response bodies as the tests read them (supertest types `body` as any).
type Of<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;
type PickRoute = Of<FloorPlanService['pickRoute']>;
type FloorItem = Of<FloorPlanService['createRack']>;
type FloorPlan = Of<FloorPlanService['floorPlan']>;
type Contents = Of<FloorPlanService['contents']>;
type PutAway = Of<FloorPlanService['putAway']>;
type Route = Extract<PickRoute, { stops: unknown }>;
type RouteList = Extract<PickRoute, { orders: unknown }>;
type Placed = Of<FloorPlanService['setPlacement']>;
type Rotated = Of<FloorPlanService['rotate']>;
type Moved = Of<InventoryService['moveFromLocation']>;
type Counted = Of<InventoryService['countLocation']>;
type Removed = { result: 'deleted' | 'deactivated' };
type Created = { data: { id: string } };
type ApiError = { message: string };
const body = <T>(res: request.Response) => res.body as T;

/** A PrismaClient that counts the SQL statements it sends. */
function countingClient() {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
    log: [{ emit: 'event', level: 'query' }],
  });
  const counter = { queries: 0 };
  client.$on('query', () => {
    counter.queries++;
  });
  return { client, counter };
}

describe('Rack map (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let counter: { queries: number };
  let inventory: InventoryService;
  let warehouseId: string;

  const api = () => request(app.getHttpServer());
  const loc = (code: string, wh = warehouseId) =>
    prisma.storageLocation.findUniqueOrThrow({
      where: { warehouseId_code: { warehouseId: wh, code } },
    });
  const movementCount = () => prisma.inventoryMovement.count();

  /** Runs a layout change and checks it wrote no ledger rows. */
  async function noMovements<T>(fn: () => Promise<T>): Promise<T> {
    const before = await movementCount();
    const result = await fn();
    expect(await movementCount()).toBe(before);
    return result;
  }

  async function createVariant(suffix: string) {
    const product = await prisma.product.create({
      data: {
        name: `E2E ${RUN} ${suffix}`,
        slug: `e2e-${RUN}-${suffix}`.toLowerCase(),
      },
    });
    return prisma.productVariant.create({
      data: { productId: product.id, sku: `E2E-${RUN}-${suffix}`, price: 100 },
    });
  }

  async function receive(
    variantId: string,
    locationId: string | null,
    quantity: number,
  ) {
    await prisma.$transaction((tx) =>
      inventory.applyMovement(tx, {
        variantId,
        warehouseId,
        locationId,
        type: 'PURCHASE_RECEIVED',
        quantity,
        unitCost: 10,
      }),
    );
    return prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
  }

  async function expectRacksMatchOnHand(levelId: string) {
    const level = await prisma.inventoryLevel.findUniqueOrThrow({
      where: { id: levelId },
    });
    const { _sum } = await prisma.locationStock.aggregate({
      where: { inventoryLevelId: levelId },
      _sum: { quantity: true },
    });
    expect(_sum.quantity ?? 0).toBe(level.onHand);
  }

  beforeAll(async () => {
    ({ client: prisma, counter } = countingClient());
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    inventory = app.get(InventoryService);

    const warehouse = await prisma.warehouse.create({
      data: { code: `E2E-${RUN}`, name: `E2E ${RUN}`, type: 'PHYSICAL' },
    });
    warehouseId = warehouse.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  // ═════════════════════════════════════════════════
  //   Layout
  // ═════════════════════════════════════════════════

  describe('layout', () => {
    it('needs a floor size before racks can be placed', async () => {
      const res = await api()
        .post(`/inventory/warehouses/${warehouseId}/racks`)
        .send({ code: 'A', levels: 2, binsPerLevel: 3, rotation: 0 });
      expect(res.status).toBe(409);
      expect(body<ApiError>(res).message).toMatch(/floor size/);
    });

    it('sets the floor size', async () => {
      const res = await noMovements(() =>
        api()
          .put(`/inventory/warehouses/${warehouseId}/floor-size`)
          .send({ floorWidth: 30, floorDepth: 20 }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ floorWidth: 30, floorDepth: 20 });
    });

    it('creates a rack with codes, levels, slots and sequences', async () => {
      const res = await noMovements(() =>
        api()
          .post(`/inventory/warehouses/${warehouseId}/racks`)
          .send({ code: 'a', levels: 2, binsPerLevel: 3, rotation: 0 }),
      );
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        code: 'A',
        type: 'RACK',
        isPickable: false,
        pickSequence: 100,
        pickFace: 'east',
        slotCount: 3,
        // First free spot: 1.2 × 4.2 m box in the north-west corner.
        placement: {
          centerX: 0.6,
          centerY: 2.1,
          length: 4.2,
          depth: 1.2,
          rotation: 0,
        },
        box: { x: 0, y: 0, width: 1.2, height: 4.2 },
        stock: { units: 0, value: '0.00', skuCount: 0, movements: 0 },
      });
      expect(
        body<FloorItem>(res).levels!.map(
          (l: {
            levelNumber: number;
            bins: { code: string; slotIndex: number }[];
          }) => [l.levelNumber, l.bins.map((b) => `${b.code}@${b.slotIndex}`)],
        ),
      ).toEqual([
        [1, ['A-1-A@0', 'A-1-B@1', 'A-1-C@2']],
        [2, ['A-2-A@0', 'A-2-B@1', 'A-2-C@2']],
      ]);

      const shelf = await loc('A-L2');
      expect(shelf).toMatchObject({
        type: 'SHELF',
        levelNumber: 2,
        pickSequence: 120,
        isPickable: false,
      });
      const bin = await loc('A-2-C');
      expect(bin).toMatchObject({
        type: 'BIN',
        slotIndex: 2,
        pickSequence: 123,
        isPickable: true,
        parentId: shelf.id,
      });
    });

    it('rejects a code that is taken or would clash with bins', async () => {
      for (const code of ['A', 'A-1']) {
        const res = await api()
          .post(`/inventory/warehouses/${warehouseId}/racks`)
          .send({ code, levels: 1, binsPerLevel: 1, rotation: 0 });
        expect(res.status).toBe(409);
      }
    });

    it('places racks inside the floor with 0.5 m clearance', async () => {
      const b = await api()
        .post(`/inventory/warehouses/${warehouseId}/racks`)
        .send({
          code: 'B',
          levels: 1,
          binsPerLevel: 2,
          rotation: 0,
          placement: {
            centerX: 10,
            centerY: 10,
            length: 4,
            depth: 1.2,
            rotation: 0,
          },
        });
      expect(b.status).toBe(201);
      const a = await loc('A');

      // 0.3 m from B.
      const tooClose = await noMovements(() =>
        api().patch(`/inventory/locations/${a.id}/placement`).send({
          centerX: 11.5,
          centerY: 10,
          length: 4.2,
          depth: 1.2,
          rotation: 0,
        }),
      );
      expect(tooClose.status).toBe(409);
      expect(body<ApiError>(tooClose).message).toBe(
        'A would touch B. Leave at least 0.5 m between racks.',
      );

      const offFloor = await api()
        .patch(`/inventory/locations/${a.id}/placement`)
        .send({
          centerX: 29.8,
          centerY: 10,
          length: 4.2,
          depth: 1.2,
          rotation: 0,
        });
      expect(offFloor.status).toBe(409);
      expect(body<ApiError>(offFloor).message).toMatch(
        /doesn't fit on the 30 × 20 m floor/,
      );

      const ok = await noMovements(() =>
        api().patch(`/inventory/locations/${a.id}/placement`).send({
          centerX: 12,
          centerY: 10,
          length: 4.2,
          depth: 1.2,
          rotation: 0,
        }),
      );
      expect(ok.status).toBe(200);
      expect(body<Placed>(ok).box).toEqual({
        x: 11.4,
        y: 7.9,
        width: 1.2,
        height: 4.2,
      });
    });

    it('lets zones overlap racks, but not rotate', async () => {
      const zone = await api()
        .post('/inventory/locations')
        .send({ warehouseId, code: 'Z1', type: 'ZONE', isPickable: false });
      expect(zone.status).toBe(201);

      const placed = await api()
        .patch(`/inventory/locations/${body<Created>(zone).data.id}/placement`)
        .send({ centerX: 10, centerY: 10, length: 10, depth: 8, rotation: 0 });
      expect(placed.status).toBe(200);
      expect(body<Placed>(placed).box).toEqual({
        x: 5,
        y: 6,
        width: 10,
        height: 8,
      });

      const turned = await api()
        .post(`/inventory/locations/${body<Created>(zone).data.id}/rotate`)
        .send({ direction: 'cw' });
      expect(turned.status).toBe(400);
    });

    it('four turns return the original placement', async () => {
      const d = await api()
        .post(`/inventory/warehouses/${warehouseId}/racks`)
        .send({
          code: 'D',
          levels: 1,
          binsPerLevel: 1,
          rotation: 90,
          placement: {
            centerX: 25,
            centerY: 15,
            length: 2,
            depth: 1,
            rotation: 90,
          },
        });
      expect(d.status).toBe(201);

      const faces: (string | null)[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await noMovements(() =>
          api()
            .post(`/inventory/locations/${body<FloorItem>(d).id}/rotate`)
            .send({ direction: 'cw' }),
        );
        expect(res.status).toBe(200);
        expect(body<Rotated>(res).shifted).toBe(false);
        faces.push(body<Rotated>(res).pickFace);
      }
      expect(faces).toEqual(['west', 'north', 'east', 'south']);
      const after = await loc('D');
      expect([
        Number(after.mapCenterX),
        Number(after.mapCenterY),
        after.mapRotation,
      ]).toEqual([25, 15, 90]);
    });

    it('nudges a rack that would collide when turned', async () => {
      // B (10,10) turned to 90 is 4 m wide and would touch A at x 11.4.
      const b = await loc('B');
      const res = await noMovements(() =>
        api()
          .post(`/inventory/locations/${b.id}/rotate`)
          .send({ direction: 'cw' }),
      );
      expect(res.status).toBe(200);
      expect(body<Rotated>(res).shifted).toBe(true);
      expect(body<Rotated>(res).placement.rotation).toBe(90);
      expect(
        body<Rotated>(res).box.x + body<Rotated>(res).box.width + 0.5,
      ).toBeLessThanOrEqual(11.4);
    });

    it('refuses a turn with no room within 4 m', async () => {
      const small = await prisma.warehouse.create({
        data: {
          code: `E2E-${RUN}-S`,
          name: `E2E ${RUN} small`,
          floorWidth: 6,
          floorDepth: 3,
        },
      });
      const rack = await api()
        .post(`/inventory/warehouses/${small.id}/racks`)
        .send({
          code: 'L',
          levels: 1,
          binsPerLevel: 1,
          rotation: 90,
          placement: {
            centerX: 3,
            centerY: 1.5,
            length: 5,
            depth: 1,
            rotation: 90,
          },
        });
      expect(rack.status).toBe(201);

      const res = await api()
        .post(`/inventory/locations/${body<FloorItem>(rack).id}/rotate`)
        .send({ direction: 'cw' });
      expect(res.status).toBe(409);
      expect(body<ApiError>(res).message).toMatch(/L has no room to turn/);
    });

    it('rejects shrinking the floor under placed racks', async () => {
      const res = await api()
        .put(`/inventory/warehouses/${warehouseId}/floor-size`)
        .send({ floorWidth: 20, floorDepth: 20 });
      expect(res.status).toBe(409);
      expect(body<ApiError>(res).message).toMatch(/^D would fall outside/);
    });
  });

  // ═════════════════════════════════════════════════
  //   Stock moves
  // ═════════════════════════════════════════════════

  describe('moving stock between bins', () => {
    let v1: { id: string };
    let levelId: string;

    beforeAll(async () => {
      v1 = await createVariant('V1');
      levelId = (await receive(v1.id, (await loc('A-1-A')).id, 10)).id;
    });

    it('writes exactly one LOCATION_MOVE and keeps racks = onHand', async () => {
      const [from, to] = [await loc('A-1-A'), await loc('A-1-B')];
      const before = await prisma.inventoryMovement.count({
        where: { inventoryLevelId: levelId },
      });

      const res = await api()
        .post(`/inventory/locations/${from.id}/moves`)
        .send({
          inventoryLevelId: levelId,
          toLocationId: to.id,
          quantity: 4,
          makeDefault: true,
        });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        movementId: expect.any(String) as string,
        from: { locationId: from.id, quantity: 6 },
        to: { locationId: to.id, quantity: 4 },
      });

      const added = await prisma.inventoryMovement.findMany({
        where: { inventoryLevelId: levelId },
        orderBy: { createdAt: 'asc' },
        skip: before,
      });
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({
        id: body<Moved>(res).movementId,
        type: 'LOCATION_MOVE',
        direction: 'INTERNAL',
        quantity: 4,
        onHandBefore: 10,
        onHandAfter: 10,
        fromLocationId: from.id,
        toLocationId: to.id,
      });
      await expectRacksMatchOnHand(levelId);
      const level = await prisma.inventoryLevel.findUniqueOrThrow({
        where: { id: levelId },
      });
      expect(level.defaultLocationId).toBe(to.id);
    });

    it('rejects more than the source holds', async () => {
      const [from, to] = [await loc('A-1-A'), await loc('A-1-C')];
      const res = await api()
        .post(`/inventory/locations/${from.id}/moves`)
        .send({ inventoryLevelId: levelId, toLocationId: to.id, quantity: 7 });
      expect(res.status).toBe(400);
      expect(body<ApiError>(res).message).toBe(
        "A-1-A holds 6 unit(s) of this SKU; can't move 7",
      );
    });

    it('rejects inactive and non-leaf destinations', async () => {
      const from = await loc('A-1-A');
      const inactive = await loc('A-2-C');
      const off = await api()
        .patch(`/inventory/locations/${inactive.id}`)
        .send({ isActive: false });
      expect(off.status).toBe(200);

      const toInactive = await api()
        .post(`/inventory/locations/${from.id}/moves`)
        .send({
          inventoryLevelId: levelId,
          toLocationId: inactive.id,
          quantity: 1,
        });
      expect(toInactive.status).toBe(400);
      expect(body<ApiError>(toInactive).message).toBe('A-2-C is inactive');

      const toRack = await api()
        .post(`/inventory/locations/${from.id}/moves`)
        .send({
          inventoryLevelId: levelId,
          toLocationId: (await loc('A')).id,
          quantity: 1,
        });
      expect(toRack.status).toBe(400);
      expect(body<ApiError>(toRack).message).toMatch(
        /doesn't hold stock directly/,
      );
    });
  });

  // ═════════════════════════════════════════════════
  //   Reads
  // ═════════════════════════════════════════════════

  describe('floor plan, contents and put-away', () => {
    it('returns racks with per-bin stock and activity', async () => {
      const res = await api().get(
        `/inventory/warehouses/${warehouseId}/floor-plan`,
      );
      expect(res.status).toBe(200);
      expect(body<FloorPlan>(res).warehouse).toMatchObject({
        id: warehouseId,
        floorWidth: 30,
        floorDepth: 20,
      });

      const a = body<FloorPlan>(res).items.find(
        (i: { code: string }) => i.code === 'A',
      )!;
      const binB = a.levels![0].bins[1];
      expect(binB).toMatchObject({
        code: 'A-1-B',
        stock: { units: 4, value: '40.00', skuCount: 1, movements: 1 },
        topSkus: [{ sku: `E2E-${RUN}-V1`, quantity: 4 }],
      });
      // receive + move into A-1-A, move out: 2 rows touch A-1-A; the A-1-A →
      // A-1-B move is counted once for the rack.
      expect(a.stock).toMatchObject({
        units: 10,
        value: '100.00',
        skuCount: 1,
        movements: 2,
      });
      expect(
        body<FloorPlan>(res).items.map((i: { code: string }) => i.code),
      ).toEqual(expect.arrayContaining(['A', 'B', 'D', 'Z1']));
      expect(body<FloorPlan>(res).totals).toMatchObject({
        unitsOnRacks: 10,
        binsTotal: 9,
        binsUsed: 2,
      });
      expect(body<FloorPlan>(res).maxCell).toEqual({
        units: 6,
        value: '60.00',
        movements: 2,
      });
      expect(body<FloorPlan>(res).activityDays).toBe(30);
    });

    it('runs a bounded number of queries however many racks there are', async () => {
      const measure = async () => {
        const start = counter.queries;
        const res = await api().get(
          `/inventory/warehouses/${warehouseId}/floor-plan?activityDays=7`,
        );
        expect(res.status).toBe(200);
        return counter.queries - start;
      };
      const before = await measure();

      for (const code of ['E', 'F', 'G']) {
        await api()
          .post(`/inventory/warehouses/${warehouseId}/racks`)
          .send({ code, levels: 2, binsPerLevel: 2, rotation: 0 });
        const v = await createVariant(code);
        await receive(v.id, (await loc(`${code}-1-A`)).id, 3);
      }

      const after = await measure();
      expect(after).toBe(before);
      expect(after).toBeLessThanOrEqual(10);
    });

    it('lists what a bin holds', async () => {
      const bin = await loc('A-1-B');
      const res = await api().get(`/inventory/locations/${bin.id}/contents`);
      expect(res.status).toBe(200);
      expect(body<Contents>(res).location).toMatchObject({
        code: 'A-1-B',
        type: 'BIN',
        rackId: (await loc('A')).id,
      });
      expect(body<Contents>(res).rows).toEqual([
        expect.objectContaining({
          sku: `E2E-${RUN}-V1`,
          variantLabel: 'Standard',
          quantity: 4,
          unitCost: '10.00',
          value: '40.00',
          isDefault: true,
        }),
      ]);
      expect(body<Contents>(res).recentMovements[0]).toMatchObject({
        type: 'LOCATION_MOVE',
        fromLocationCode: 'A-1-A',
        toLocationCode: 'A-1-B',
      });
    });

    it('suggests where waiting stock should go', async () => {
      const v1 = await prisma.productVariant.findUniqueOrThrow({
        where: { sku: `E2E-${RUN}-V1` },
      });
      const v2 = await createVariant('V2');
      const unassigned = await inventory.getUnassignedLocationId(
        prisma,
        warehouseId,
      );
      await receive(v1.id, unassigned, 2);
      await receive(v2.id, unassigned, 5);

      const res = await api().get(
        `/inventory/warehouses/${warehouseId}/put-away`,
      );
      expect(res.status).toBe(200);
      const bySku = Object.fromEntries(
        body<PutAway>(res).lines.map(
          (l: { sku: string; suggestedLocationCode: string | null }) => [
            l.sku,
            l.suggestedLocationCode,
          ],
        ),
      );
      expect(bySku[`E2E-${RUN}-V1`]).toBe('A-1-B'); // its default bin
      expect(bySku[`E2E-${RUN}-V2`]).toBe('A-1-C'); // first empty bin
    });
  });

  // ═════════════════════════════════════════════════
  //   Pick route
  // ═════════════════════════════════════════════════

  describe('pick route', () => {
    it('matches what committing the reservations actually picks', async () => {
      // A packing station is where walks start and end.
      const pack = await api().post('/inventory/locations').send({
        warehouseId,
        code: 'PACK',
        type: 'PACKING',
        isPickable: false,
      });
      await api()
        .patch(`/inventory/locations/${body<Created>(pack).data.id}/placement`)
        .send({ centerX: 28, centerY: 2, length: 2, depth: 2, rotation: 0 });

      const order = await prisma.order.create({
        data: {
          orderNumber: `E2E-${RUN}`,
          customerEmail: 'e2e@shop.test',
          subtotalAmount: 0,
          totalAmount: 0,
        },
      });
      const [v1, v2] = await Promise.all(
        ['V1', 'V2'].map((s) =>
          prisma.productVariant.findUniqueOrThrow({
            where: { sku: `E2E-${RUN}-${s}` },
          }),
        ),
      );
      await prisma.$transaction((tx) =>
        inventory.reserveForOrder(tx, order.id, [
          { variantId: v1.id, quantity: 9 },
          { variantId: v2.id, quantity: 3 },
        ]),
      );

      const list = await api().get(
        `/inventory/warehouses/${warehouseId}/pick-route`,
      );
      expect(body<RouteList>(list).orders).toContainEqual({
        orderId: order.id,
        lines: 2,
      });

      const route = await api().get(
        `/inventory/warehouses/${warehouseId}/pick-route?orderId=${order.id}`,
      );
      expect(route.status).toBe(200);
      expect(route.body).toMatchObject({
        orderId: order.id,
        start: { x: 28, y: 2 },
        end: { x: 28, y: 2 },
        startLocationCode: 'PACK',
        shortages: [],
      });
      const stops: {
        sequence: number;
        locationCode: string;
        locationId: string;
        inventoryLevelId: string;
        quantity: number;
        point: unknown;
      }[] = body<Route>(route).stops;
      expect(stops.map((s) => s.sequence)).toEqual(stops.map((_, i) => i + 1));
      // Walk order: rack bins (pickSequence 111, 112) before UNASSIGNED.
      expect(stops.map((s) => s.locationCode)).toEqual([
        'A-1-A',
        'A-1-B',
        'UNASSIGNED',
        'UNASSIGNED',
      ]);
      // Bins on placed racks get a stop point at the pick face (east of A).
      expect(stops[0].point).toEqual({ x: 13.35, y: 8.74 }); // 0.75 m east of x = 12.6, level with slot A

      await prisma.$transaction((tx) =>
        inventory.commitOrderReservations(tx, order.id),
      );
      const sales = await prisma.inventoryMovement.findMany({
        where: { type: 'SALE', referenceId: order.id },
      });
      const key = (x: {
        inventoryLevelId: string;
        locationId: string | null;
        quantity: number;
      }) => `${x.inventoryLevelId}|${x.locationId}|${x.quantity}`;
      expect(
        sales.map((s) => key({ ...s, locationId: s.fromLocationId })).sort(),
      ).toEqual(stops.map((s) => key(s)).sort());
    });
  });

  // ═════════════════════════════════════════════════
  //   Bin counts
  // ═════════════════════════════════════════════════

  describe('bin counts', () => {
    let binId: string;
    let levelId: string;
    let held: number;

    beforeAll(async () => {
      // A-1-A still holds V1 after the pick-route commit (A-1-B was emptied).
      binId = (await loc('A-1-A')).id;
      const v1 = await prisma.productVariant.findUniqueOrThrow({
        where: { sku: `E2E-${RUN}-V1` },
      });
      levelId = (
        await prisma.inventoryLevel.findUniqueOrThrow({
          where: { variantId_warehouseId: { variantId: v1.id, warehouseId } },
        })
      ).id;
      held = (
        await prisma.locationStock.findUniqueOrThrow({
          where: {
            inventoryLevelId_locationId: {
              inventoryLevelId: levelId,
              locationId: binId,
            },
          },
        })
      ).quantity;
      expect(held).toBeGreaterThan(0);
    });

    it('creates nothing when the count matches', async () => {
      const res = await api()
        .post(`/inventory/locations/${binId}/counts`)
        .send({
          lines: [{ inventoryLevelId: levelId, countedQty: held }],
          applyNow: true,
        });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ adjustment: null });
    });

    it('leaves the adjustment pending without an approver', async () => {
      const before = await movementCount();
      const res = await api()
        .post(`/inventory/locations/${binId}/counts`)
        .send({
          lines: [{ inventoryLevelId: levelId, countedQty: held + 2 }],
          applyNow: true,
        });
      expect(res.status).toBe(201);
      expect(body<Counted>(res).adjustment).toMatchObject({
        status: 'PENDING',
        adjustmentNumber: expect.stringMatching(/^ADJ-\d{4}-\d{5}$/) as string,
      });
      expect(await movementCount()).toBe(before);

      const items = await prisma.stockAdjustmentItem.findMany({
        where: { adjustmentId: body<Counted>(res).adjustment!.id },
      });
      expect(items).toEqual([
        expect.objectContaining({
          locationId: binId,
          expectedQty: held,
          actualQty: held + 2,
          adjustmentQty: 2,
        }),
      ]);
      const adj = await prisma.stockAdjustment.findUniqueOrThrow({
        where: { id: body<Counted>(res).adjustment!.id },
      });
      expect(adj).toMatchObject({ type: 'CYCLE_COUNT', reason: 'CYCLE_COUNT' });
    });

    it('applies it right away for an admin', async () => {
      const admin = await prisma.user.create({
        data: { email: `e2e-${RUN.toLowerCase()}@shop.test`, role: 'ADMIN' },
      });
      const res = await api()
        .post(`/inventory/locations/${binId}/counts?actedBy=${admin.id}`)
        .send({
          lines: [{ inventoryLevelId: levelId, countedQty: held - 1 }],
          applyNow: true,
        });
      expect(res.status).toBe(201);
      expect(body<Counted>(res).adjustment!.status).toBe('APPLIED');

      const stock = await prisma.locationStock.findUniqueOrThrow({
        where: {
          inventoryLevelId_locationId: {
            inventoryLevelId: levelId,
            locationId: binId,
          },
        },
      });
      expect(stock.quantity).toBe(held - 1);
      const movement = await prisma.inventoryMovement.findFirstOrThrow({
        where: {
          referenceType: 'ADJUSTMENT',
          referenceId: body<Counted>(res).adjustment!.id,
        },
      });
      expect(movement).toMatchObject({
        type: 'ADJUSTMENT_DECREASE',
        quantity: 1,
        fromLocationId: binId,
        performedByUserId: admin.id,
      });
      await expectRacksMatchOnHand(levelId);
    });
  });

  // ═════════════════════════════════════════════════
  //   Removing racks
  // ═════════════════════════════════════════════════

  describe('removing racks', () => {
    it('refuses while stock is on it', async () => {
      const a = await loc('A');
      const res = await api().delete(`/inventory/locations/${a.id}`);
      expect(res.status).toBe(409);
      expect(body<ApiError>(res).message).toMatch(
        /Move the \d+ units out first/,
      );
    });

    it('deletes a rack with no history', async () => {
      const d = await loc('D');
      const res = await noMovements(() =>
        api().delete(`/inventory/locations/${d.id}`),
      );
      expect(res.status).toBe(200);
      expect(body<Removed>(res).result).toBe('deleted');
      expect(
        await prisma.storageLocation.count({
          where: { warehouseId, code: { startsWith: 'D' } },
        }),
      ).toBe(0);
    });

    it('deactivates a rack with history, keeping its placement', async () => {
      // Give B history: stock in and back out again.
      const v = await createVariant('VB');
      const level = await receive(v.id, (await loc('B-1-A')).id, 2);
      const move = await api()
        .post(`/inventory/locations/${(await loc('B-1-A')).id}/moves`)
        .send({
          inventoryLevelId: level.id,
          toLocationId: (await loc('A-1-C')).id,
          quantity: 2,
        });
      expect(move.status).toBe(201);

      const b = await loc('B');
      const res = await noMovements(() =>
        api().delete(`/inventory/locations/${b.id}`),
      );
      expect(res.status).toBe(200);
      expect(body<Removed>(res).result).toBe('deactivated');

      const subtree = await prisma.storageLocation.findMany({
        where: { warehouseId, code: { startsWith: 'B' } },
      });
      expect(subtree.length).toBe(1 + 1 + 2); // rack, shelf, 2 bins
      expect(subtree.every((l) => !l.isActive)).toBe(true);
      expect((await loc('B')).mapCenterX).not.toBeNull();
    });
  });
});
