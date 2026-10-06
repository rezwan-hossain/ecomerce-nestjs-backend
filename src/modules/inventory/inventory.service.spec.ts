import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import {
  generateBatchNumber,
  InventoryService,
  stockStatusOf,
} from './inventory.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma/client';

const VARIANT = 'variant-1';
const WAREHOUSE = 'wh-main';
const UNASSIGNED = 'loc-unassigned';

type Level = {
  id: string;
  warehouseId: string;
  onHand: number;
  reserved: number;
  unitCost: Decimal;
  defaultLocationId: string | null;
};

function level(overrides: Partial<Level> = {}): Level {
  return {
    id: 'level-1',
    warehouseId: WAREHOUSE,
    onHand: 10,
    reserved: 0,
    unitCost: new Decimal(0),
    defaultLocationId: null,
    ...overrides,
  };
}

/** A LocationStock row as planPick reads it. */
function rack(
  locationId: string,
  quantity: number,
  extra: { isPickable?: boolean; pickSequence?: number } = {},
) {
  return {
    locationId,
    quantity,
    location: {
      code: locationId.toUpperCase(),
      isPickable: extra.isPickable ?? true,
      pickSequence: extra.pickSequence ?? 0,
    },
  };
}

function createMockPrisma() {
  const tx = {
    warehouse: { findFirst: jest.fn() },
    inventoryLevel: {
      upsert: jest.fn().mockResolvedValue({ id: 'level-1' }),
      update: jest.fn((args: { data: object }) => args.data),
    },
    inventoryMovement: {
      create: jest.fn((args: { data: unknown }) => args.data),
      findMany: jest.fn().mockResolvedValue([]),
    },
    locationStock: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    storageLocation: {
      upsert: jest.fn().mockResolvedValue({ id: UNASSIGNED }),
      findUnique: jest.fn().mockResolvedValue({
        warehouseId: WAREHOUSE,
        isActive: true,
        code: 'A-01',
      }),
    },
    stockReservation: {
      create: jest.fn((args: { data: object }) => ({
        id: 'res-new',
        ...args.data,
      })),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    productVariant: { findUnique: jest.fn() },
    supplier: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ isActive: true, name: 'Bengal Leather Co.' }),
    },
    inventoryBatch: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn((args: { data: object }) => ({
        id: 'batch-1',
        ...args.data,
      })),
    },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  };
  return {
    tx,
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
}

type MockPrisma = ReturnType<typeof createMockPrisma>;

function callArg<T>(mockFn: jest.Mock, call = 0): T {
  const args = mockFn.mock.calls[call] as unknown[];
  return args[0] as T;
}

describe('InventoryService', () => {
  let service: InventoryService;
  let prisma: MockPrisma;
  let tx: MockPrisma['tx'];

  beforeEach(async () => {
    prisma = createMockPrisma();
    tx = prisma.tx;
    tx.warehouse.findFirst.mockResolvedValue({ id: WAREHOUSE });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
  });

  afterEach(() => jest.clearAllMocks());

  const asTx = () => tx as unknown as Prisma.TransactionClient;

  // ═════════════════════════════════════════════════
  //   applyMovement — warehouse level
  // ═════════════════════════════════════════════════

  describe('applyMovement', () => {
    it('decrements onHand and logs before/after', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 10, reserved: 2 })]);
      tx.locationStock.findMany.mockResolvedValue([rack('a-01', 10)]);

      const [movement] = await service.applyMovement(asTx(), {
        variantId: VARIANT,
        type: 'LOST',
        quantity: 3,
        userId: 'admin-1',
      });

      expect(
        callArg<{ data: object }>(tx.inventoryLevel.update).data,
      ).toMatchObject({ onHand: 7, available: 5 });
      expect(movement).toMatchObject({
        type: 'LOST',
        direction: 'OUT',
        quantity: 3,
        onHandBefore: 10,
        onHandAfter: 7,
        fromLocationId: 'a-01',
        performedByUserId: 'admin-1',
      });
      expect(tx.$executeRaw).toHaveBeenCalled(); // variant stock re-synced
    });

    it('refuses to take reserved stock', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 5, reserved: 3 })]);
      tx.productVariant.findUnique.mockResolvedValue({ sku: 'SKU-1' });

      await expect(
        service.applyMovement(asTx(), {
          variantId: VARIANT,
          type: 'ADJUSTMENT_DECREASE',
          quantity: 3,
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'Not enough stock for SKU "SKU-1": 2 available, 3 requested',
        ),
      );
      expect(tx.inventoryLevel.update).not.toHaveBeenCalled();
      expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    });

    it('updates the weighted average cost on inbound stock', async () => {
      tx.$queryRaw.mockResolvedValue([
        level({ onHand: 10, unitCost: new Decimal(100) }),
      ]);

      await service.applyMovement(asTx(), {
        variantId: VARIANT,
        type: 'PURCHASE_RECEIVED',
        quantity: 10,
        unitCost: 200,
      });

      const data = callArg<{
        data: { onHand: number; unitCost: Decimal; totalCost: Decimal };
      }>(tx.inventoryLevel.update).data;
      expect(data.onHand).toBe(20);
      expect(data.unitCost.toString()).toBe('150');
      expect(data.totalCost.toString()).toBe('3000');
    });

    it('moves DAMAGED units into the damaged bucket', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 4 })]);
      tx.locationStock.findMany.mockResolvedValue([rack('a-01', 4)]);

      await service.applyMovement(asTx(), {
        variantId: VARIANT,
        type: 'DAMAGED',
        quantity: 1,
      });

      expect(
        callArg<{ data: object }>(tx.inventoryLevel.update).data,
      ).toMatchObject({ onHand: 3, damaged: { increment: 1 } });
    });

    it.each([
      ['a reservation type', 'RESERVATION_CREATED' as const, 1],
      ['a rack move', 'LOCATION_MOVE' as const, 1],
      ['zero quantity', 'ADJUSTMENT_INCREASE' as const, 0],
      ['negative quantity', 'ADJUSTMENT_INCREASE' as const, -2],
    ])('rejects %s', async (_label, type, quantity) => {
      await expect(
        service.applyMovement(asTx(), { variantId: VARIANT, type, quantity }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.inventoryLevel.update).not.toHaveBeenCalled();
    });

    it('fails clearly when no default warehouse exists', async () => {
      tx.warehouse.findFirst.mockResolvedValue(null);
      await expect(
        service.applyMovement(asTx(), {
          variantId: VARIANT,
          type: 'INITIAL_STOCK',
          quantity: 1,
        }),
      ).rejects.toThrow(/No active default warehouse/);
    });
  });

  // ═════════════════════════════════════════════════
  //   applyMovement — racks
  // ═════════════════════════════════════════════════

  describe('put-away (inbound)', () => {
    it('uses the explicit rack when given', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 0 })]);

      const [movement] = await service.applyMovement(asTx(), {
        variantId: VARIANT,
        locationId: 'b-07',
        type: 'PURCHASE_RECEIVED',
        quantity: 5,
      });

      expect(movement).toMatchObject({ toLocationId: 'b-07', quantity: 5 });
      expect(tx.locationStock.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            locationId: 'b-07',
            warehouseId: WAREHOUSE,
            quantity: 5,
          }) as object,
          update: { quantity: { increment: 5 } },
        }),
      );
    });

    it('falls back to the default rack, then UNASSIGNED', async () => {
      tx.$queryRaw.mockResolvedValueOnce([
        level({ onHand: 0, defaultLocationId: 'a-03' }),
      ]);
      const [toDefault] = await service.applyMovement(asTx(), {
        variantId: VARIANT,
        type: 'PURCHASE_RECEIVED',
        quantity: 1,
      });
      expect(toDefault).toMatchObject({ toLocationId: 'a-03' });

      tx.$queryRaw.mockResolvedValueOnce([level({ onHand: 1 })]);
      const [toUnassigned] = await service.applyMovement(asTx(), {
        variantId: VARIANT,
        type: 'PURCHASE_RECEIVED',
        quantity: 1,
      });
      expect(toUnassigned).toMatchObject({ toLocationId: UNASSIGNED });
    });

    it('skips an inactive default rack', async () => {
      tx.$queryRaw.mockResolvedValue([
        level({ onHand: 0, defaultLocationId: 'a-03' }),
      ]);
      tx.storageLocation.findUnique.mockResolvedValue({ isActive: false });

      const [movement] = await service.applyMovement(asTx(), {
        variantId: VARIANT,
        type: 'PURCHASE_RECEIVED',
        quantity: 1,
      });
      expect(movement).toMatchObject({ toLocationId: UNASSIGNED });
    });

    it('rejects a rack from another warehouse', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 0 })]);
      tx.storageLocation.findUnique.mockResolvedValue({
        warehouseId: 'other-wh',
        isActive: true,
        code: 'X-01',
      });

      await expect(
        service.applyMovement(asTx(), {
          variantId: VARIANT,
          locationId: 'x-01',
          type: 'PURCHASE_RECEIVED',
          quantity: 1,
        }),
      ).rejects.toThrow(/different warehouse/);
      expect(tx.inventoryLevel.update).not.toHaveBeenCalled();
    });
  });

  describe('picking (outbound)', () => {
    it('takes from the default rack first, then the smaller pile', async () => {
      tx.$queryRaw.mockResolvedValue([
        level({ onHand: 50, defaultLocationId: 'b-07' }),
      ]);
      tx.locationStock.findMany.mockResolvedValue([
        rack('a-03', 20),
        rack('c-01', 25),
        rack('b-07', 5),
      ]);

      const movements = await service.applyMovement(asTx(), {
        variantId: VARIANT,
        type: 'ADJUSTMENT_DECREASE',
        quantity: 30,
      });

      expect(movements.map((m) => [m.fromLocationId, m.quantity])).toEqual([
        ['b-07', 5],
        ['a-03', 20],
        ['c-01', 5],
      ]);
      // Snapshots step through each leg.
      expect(movements.map((m) => [m.onHandBefore, m.onHandAfter])).toEqual([
        [50, 45],
        [45, 25],
        [25, 20],
      ]);
      expect(tx.locationStock.updateMany).toHaveBeenCalledTimes(3);
    });

    it('prefers pickable racks over e.g. the receiving dock', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 10 })]);
      tx.locationStock.findMany.mockResolvedValue([
        rack('dock', 2, { isPickable: false }),
        rack('a-01', 8),
      ]);

      const [first] = await service.applyMovement(asTx(), {
        variantId: VARIANT,
        type: 'LOST',
        quantity: 1,
      });
      expect(first).toMatchObject({ fromLocationId: 'a-01' });
    });

    it('takes only from the named rack and checks it holds enough', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 10 })]);
      tx.locationStock.findMany.mockResolvedValue([rack('a-01', 2)]);

      await expect(
        service.applyMovement(asTx(), {
          variantId: VARIANT,
          locationId: 'a-01',
          type: 'LOST',
          quantity: 3,
        }),
      ).rejects.toThrow(/holds 2 unit\(s\) of this variant, 3 requested/);
      expect(tx.inventoryLevel.update).not.toHaveBeenCalled();
    });

    it('reports a bug if racks do not add up to onHand', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 10 })]);
      tx.locationStock.findMany.mockResolvedValue([rack('a-01', 4)]);

      await expect(
        service.applyMovement(asTx(), {
          variantId: VARIANT,
          type: 'LOST',
          quantity: 6,
        }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  // ═════════════════════════════════════════════════
  //   moveStock / setDefaultLocation
  // ═════════════════════════════════════════════════

  describe('moveStock', () => {
    it('moves units between racks without touching onHand', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 30, reserved: 5 })]);

      const movement = await service.moveStock(asTx(), {
        variantId: VARIANT,
        fromLocationId: 'b-07',
        toLocationId: 'a-03',
        quantity: 10,
      });

      expect(movement).toMatchObject({
        type: 'LOCATION_MOVE',
        direction: 'INTERNAL',
        quantity: 10,
        onHandBefore: 30,
        onHandAfter: 30,
        fromLocationId: 'b-07',
        toLocationId: 'a-03',
      });
      expect(tx.locationStock.updateMany).toHaveBeenCalledWith({
        where: {
          inventoryLevelId: 'level-1',
          locationId: 'b-07',
          quantity: { gte: 10 },
        },
        data: { quantity: { increment: -10 } },
      });
      expect(tx.inventoryLevel.update).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects moving more than the source rack holds', async () => {
      tx.$queryRaw.mockResolvedValue([level()]);
      tx.locationStock.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.moveStock(asTx(), {
          variantId: VARIANT,
          fromLocationId: 'b-07',
          toLocationId: 'a-03',
          quantity: 99,
        }),
      ).rejects.toThrow(/doesn't hold 99 unit\(s\)/);
      expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    });

    it('rejects the same rack as source and destination', async () => {
      await expect(
        service.moveStock(asTx(), {
          variantId: VARIANT,
          fromLocationId: 'a-03',
          toLocationId: 'a-03',
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allows emptying an inactive rack but not filling one', async () => {
      tx.$queryRaw.mockResolvedValue([level()]);
      tx.storageLocation.findUnique
        .mockResolvedValueOnce({
          warehouseId: WAREHOUSE,
          isActive: false,
          code: 'OLD',
        })
        .mockResolvedValueOnce({
          warehouseId: WAREHOUSE,
          isActive: true,
          code: 'NEW',
        });
      await expect(
        service.moveStock(asTx(), {
          variantId: VARIANT,
          fromLocationId: 'old',
          toLocationId: 'new',
          quantity: 1,
        }),
      ).resolves.toBeDefined();

      tx.storageLocation.findUnique
        .mockResolvedValueOnce({
          warehouseId: WAREHOUSE,
          isActive: true,
          code: 'NEW',
        })
        .mockResolvedValueOnce({
          warehouseId: WAREHOUSE,
          isActive: false,
          code: 'OLD',
        });
      await expect(
        service.moveStock(asTx(), {
          variantId: VARIANT,
          fromLocationId: 'new',
          toLocationId: 'old',
          quantity: 1,
        }),
      ).rejects.toThrow(/"OLD" is inactive/);
    });
  });

  describe('setDefaultLocation', () => {
    it('stores the rack on the inventory level', async () => {
      tx.$queryRaw.mockResolvedValue([level()]);

      await service.setDefaultLocation(asTx(), VARIANT, 'a-03');

      expect(tx.inventoryLevel.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'level-1' },
          data: { defaultLocationId: 'a-03' },
        }),
      );
    });
  });

  // ═════════════════════════════════════════════════
  //   setStock / recordInitialStock
  // ═════════════════════════════════════════════════

  describe('setStock', () => {
    it('records a warehouse-wide difference as ADJUSTMENT_DECREASE', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 10 })]);
      tx.locationStock.findMany.mockResolvedValue([rack('a-01', 10)]);

      const movements = await service.setStock(asTx(), VARIANT, 4);

      expect(movements).toEqual([
        expect.objectContaining({
          type: 'ADJUSTMENT_DECREASE',
          direction: 'OUT',
          quantity: 6,
          onHandBefore: 10,
          onHandAfter: 4,
        }),
      ]);
    });

    it('counts a single rack against that rack only', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 50 })]);
      tx.locationStock.findUnique.mockResolvedValue({ quantity: 20 });
      tx.locationStock.findMany.mockResolvedValue([rack('a-03', 20)]);

      const movements = await service.setStock(asTx(), VARIANT, 18, {
        locationId: 'a-03',
      });

      expect(movements).toEqual([
        expect.objectContaining({
          type: 'ADJUSTMENT_DECREASE',
          quantity: 2,
          fromLocationId: 'a-03',
          onHandBefore: 50,
          onHandAfter: 48,
        }),
      ]);
    });

    it('writes nothing when the count already matches', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 4 })]);

      expect(await service.setStock(asTx(), VARIANT, 4)).toBeNull();
      expect(tx.inventoryLevel.update).not.toHaveBeenCalled();
    });
  });

  describe('recordInitialStock', () => {
    it('only opens the level when created with zero stock', async () => {
      expect(
        await service.recordInitialStock(asTx(), { id: VARIANT, stock: 0 }),
      ).toBeNull();
      expect(tx.inventoryLevel.upsert).toHaveBeenCalled();
      expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    });

    it('records costPrice as the opening unit cost', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 0 })]);

      const [movement] = (await service.recordInitialStock(
        asTx(),
        { id: VARIANT, stock: 50 },
        { unitCost: 250 },
      ))!;

      expect(movement.unitCost?.toString()).toBe('250');
      expect(movement.totalCost?.toString()).toBe('12500');
      const data = callArg<{ data: { unitCost: Decimal; totalCost: Decimal } }>(
        tx.inventoryLevel.update,
      ).data;
      expect(data.unitCost.toString()).toBe('250');
      expect(data.totalCost.toString()).toBe('12500');
    });

    it('keeps costPrice even when created with zero stock', async () => {
      await service.recordInitialStock(
        asTx(),
        { id: VARIANT, stock: 0 },
        { unitCost: 250 },
      );

      expect(tx.inventoryLevel.update).toHaveBeenCalledWith({
        where: { id: 'level-1' },
        data: { unitCost: new Decimal(250) },
      });
      expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    });

    it('books INITIAL_STOCK onto UNASSIGNED', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 0 })]);

      const movements = await service.recordInitialStock(asTx(), {
        id: VARIANT,
        stock: 12,
      });

      expect(movements).toEqual([
        expect.objectContaining({
          type: 'INITIAL_STOCK',
          direction: 'IN',
          quantity: 12,
          onHandAfter: 12,
          toLocationId: UNASSIGNED,
        }),
      ]);
    });
  });

  describe('recordInitialStock with a supplier', () => {
    it('books PURCHASE_RECEIVED linked to a supplier batch', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 0 })]);

      const movements = await service.recordInitialStock(
        asTx(),
        { id: VARIANT, stock: 20 },
        { unitCost: 450, supplierId: 'sup-1' },
      );

      const batch = callArg<{
        data: { supplierId: string; quantity: number; initialQty: number };
      }>(tx.inventoryBatch.create).data;
      expect(batch).toMatchObject({
        supplierId: 'sup-1',
        quantity: 20,
        initialQty: 20,
      });
      expect(movements).toEqual([
        expect.objectContaining({
          type: 'PURCHASE_RECEIVED',
          direction: 'IN',
          quantity: 20,
          batchId: 'batch-1',
        }),
      ]);
    });

    it('creates no batch when there is no stock', async () => {
      await service.recordInitialStock(
        asTx(),
        { id: VARIANT, stock: 0 },
        { supplierId: 'sup-1' },
      );
      expect(tx.inventoryBatch.create).not.toHaveBeenCalled();
    });
  });

  // ═════════════════════════════════════════════════
  //   receiveStock
  // ═════════════════════════════════════════════════

  describe('receiveStock', () => {
    const receipt = {
      variantId: VARIANT,
      quantity: 30,
      unitCost: 900,
      supplierId: 'sup-1',
    };

    it('keeps the reference on the batch and the movement', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 0 })]);

      const [movement] = await service.receiveStock(asTx(), {
        ...receipt,
        batchNumber: 'LOT-7',
        reference: 'INV-4512',
      });

      expect(
        callArg<{ data: { batchNumber: string; note: string } }>(
          tx.inventoryBatch.create,
        ).data,
      ).toMatchObject({ batchNumber: 'LOT-7', note: 'INV-4512' });
      expect(movement).toMatchObject({
        type: 'PURCHASE_RECEIVED',
        batchId: 'batch-1',
        note: 'Ref: INV-4512',
        metadata: { reference: 'INV-4512' },
      });
      expect(movement.unitCost?.toString()).toBe('900');
    });

    it('generates a batch number when none is given', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 0 })]);

      await service.receiveStock(asTx(), receipt);

      expect(
        callArg<{ data: { batchNumber: string } }>(tx.inventoryBatch.create)
          .data.batchNumber,
      ).toMatch(/^RCV-\d{8}-[0-9A-F]{8}$/);
    });

    it('rejects an inactive supplier', async () => {
      tx.supplier.findUnique.mockResolvedValue({
        isActive: false,
        name: 'Old Co.',
      });

      await expect(service.receiveStock(asTx(), receipt)).rejects.toThrow(
        BadRequestException,
      );
      expect(tx.inventoryBatch.create).not.toHaveBeenCalled();
    });

    it('rejects a batch number already received', async () => {
      tx.inventoryBatch.findUnique.mockResolvedValue({ id: 'batch-old' });
      tx.productVariant.findUnique.mockResolvedValue({ sku: 'WALLET-BROWN' });

      await expect(
        service.receiveStock(asTx(), { ...receipt, batchNumber: 'LOT-7' }),
      ).rejects.toThrow(ConflictException);
      expect(tx.inventoryBatch.create).not.toHaveBeenCalled();
    });

    it('rejects a non-positive quantity', async () => {
      await expect(
        service.receiveStock(asTx(), { ...receipt, quantity: 0 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('generateBatchNumber', () => {
    it('stamps the receiving date', () => {
      expect(generateBatchNumber(new Date('2026-10-06T10:00:00Z'))).toMatch(
        /^RCV-20261006-[0-9A-F]{8}$/,
      );
    });
  });

  // ═════════════════════════════════════════════════
  //   Reservations
  // ═════════════════════════════════════════════════

  describe('reserveForOrder', () => {
    it('splits a line across warehouses in routing order', async () => {
      tx.$queryRaw.mockResolvedValue([
        level({ id: 'l-main', warehouseId: 'wh-main', onHand: 3 }),
        level({ id: 'l-store', warehouseId: 'wh-store', onHand: 10 }),
      ]);

      const reservations = await service.reserveForOrder(asTx(), 'order-1', [
        { variantId: VARIANT, quantity: 5, orderItemId: 'item-1' },
      ]);

      expect(reservations).toEqual([
        { id: 'res-new', warehouseId: 'wh-main', quantity: 3 },
        { id: 'res-new', warehouseId: 'wh-store', quantity: 2 },
      ]);
      expect(
        callArg<{ data: object }>(tx.inventoryLevel.update, 1).data,
      ).toMatchObject({ reserved: 2, available: 8 });
      expect(
        callArg<{ data: object }>(tx.inventoryMovement.create).data,
      ).toMatchObject({
        type: 'RESERVATION_CREATED',
        direction: 'INTERNAL',
        onHandBefore: 3,
        onHandAfter: 3,
        reservedBefore: 0,
        reservedAfter: 3,
      });
      // Reserving is warehouse-level only — racks are untouched.
      expect(tx.locationStock.updateMany).not.toHaveBeenCalled();
    });

    it('rejects when total available stock is insufficient', async () => {
      tx.$queryRaw.mockResolvedValue([level({ onHand: 2 })]);
      tx.productVariant.findUnique.mockResolvedValue({ sku: 'SKU-1' });

      await expect(
        service.reserveForOrder(asTx(), 'order-1', [
          { variantId: VARIANT, quantity: 3 },
        ]),
      ).rejects.toThrow(
        new BadRequestException(
          'Not enough stock for SKU "SKU-1": 2 available, 3 requested',
        ),
      );
    });
  });

  describe('releaseOrderReservations', () => {
    it('frees ACTIVE reservations and marks them RELEASED', async () => {
      tx.stockReservation.findMany.mockResolvedValue([
        {
          id: 'res-1',
          inventoryLevelId: 'level-1',
          variantId: VARIANT,
          quantity: 2,
        },
      ]);
      tx.$queryRaw.mockResolvedValue([level({ onHand: 10, reserved: 5 })]);

      await service.releaseOrderReservations(asTx(), 'order-1');

      expect(
        callArg<{ data: object }>(tx.inventoryLevel.update).data,
      ).toMatchObject({ reserved: 3, available: 7 });
      expect(
        callArg<{ data: object }>(tx.stockReservation.update).data,
      ).toMatchObject({ status: 'RELEASED' });
      expect(
        callArg<{ data: object }>(tx.inventoryMovement.create).data,
      ).toMatchObject({
        type: 'RESERVATION_RELEASED',
        reservedBefore: 5,
        reservedAfter: 3,
      });
    });

    it('restocks legacy SALE movements when the order has no reservations', async () => {
      tx.stockReservation.findMany.mockResolvedValue([]);
      tx.inventoryMovement.findMany.mockResolvedValue([
        {
          quantity: 2,
          unitCost: new Decimal(0),
          inventoryLevel: { variantId: VARIANT, warehouseId: WAREHOUSE },
        },
      ]);
      tx.$queryRaw.mockResolvedValue([level({ onHand: 1 })]);

      await service.releaseOrderReservations(asTx(), 'order-1');

      expect(
        callArg<{ data: object }>(tx.inventoryMovement.create).data,
      ).toMatchObject({
        type: 'RETURN_RESTOCKED',
        direction: 'IN',
        quantity: 2,
        referenceType: 'ORDER',
        referenceId: 'order-1',
      });
    });
  });

  describe('commitOrderReservations', () => {
    it('picks racks and writes one SALE per rack', async () => {
      tx.stockReservation.findMany.mockResolvedValue([
        {
          id: 'res-1',
          inventoryLevelId: 'level-1',
          variantId: VARIANT,
          quantity: 25,
        },
      ]);
      tx.$queryRaw.mockResolvedValue([
        level({ onHand: 50, reserved: 25, unitCost: new Decimal(50) }),
      ]);
      tx.locationStock.findMany.mockResolvedValue([
        rack('a-03', 20),
        rack('b-07', 30),
      ]);

      await service.commitOrderReservations(asTx(), 'order-1');

      expect(
        callArg<{ data: object }>(tx.inventoryLevel.update).data,
      ).toMatchObject({ onHand: 25, reserved: 0 });
      expect(
        callArg<{ data: object }>(tx.stockReservation.update).data,
      ).toMatchObject({ status: 'COMMITTED' });

      const sales = tx.inventoryMovement.create.mock.calls.map(
        (c) => (c[0] as { data: Record<string, unknown> }).data,
      );
      expect(sales).toEqual([
        expect.objectContaining({
          type: 'SALE',
          fromLocationId: 'a-03',
          quantity: 20,
          onHandBefore: 50,
          onHandAfter: 30,
          reservedBefore: 25,
          reservedAfter: 5,
          referenceType: 'ORDER',
          referenceId: 'order-1',
        }),
        expect.objectContaining({
          type: 'SALE',
          fromLocationId: 'b-07',
          quantity: 5,
          onHandBefore: 30,
          onHandAfter: 25,
          reservedBefore: 5,
          reservedAfter: 0,
        }),
      ]);
      expect((sales[0].totalCost as Decimal).toString()).toBe('1000');
    });
  });

  describe('stockStatusOf', () => {
    it.each([
      [0, 5, 'OUT_OF_STOCK'],
      [5, 5, 'LOW_STOCK'],
      [6, 5, 'IN_STOCK'],
    ])(
      'stock %i with threshold %i → %s',
      (stock, lowStockThreshold, status) => {
        expect(stockStatusOf({ stock, lowStockThreshold })).toBe(status);
      },
    );
  });
});
