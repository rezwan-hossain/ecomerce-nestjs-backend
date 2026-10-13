import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { InventoryService } from './inventory.service';
import { WarehousesService } from './warehouses.service';

const WH = {
  id: 'wh-1',
  code: 'DHK-01',
  name: 'Dhaka',
  type: 'PHYSICAL',
  isActive: true,
  isDefault: false,
};

function mockDb() {
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'wh-1' }]),
    warehouse: {
      findUnique: jest.fn().mockResolvedValue(WH),
      findMany: jest.fn().mockResolvedValue([WH]),
      create: jest.fn((a: { data: object }) => ({ id: 'wh-new', ...a.data })),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    storageLocation: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn(),
    },
    inventoryLevel: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    inventoryMovement: { count: jest.fn().mockResolvedValue(0) },
    inventoryBatch: { count: jest.fn().mockResolvedValue(0) },
    purchaseOrder: { count: jest.fn().mockResolvedValue(0) },
    purchaseOrderItem: { count: jest.fn().mockResolvedValue(0) },
    inventoryTransfer: { count: jest.fn().mockResolvedValue(0) },
    stockAdjustmentItem: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((fn: (t: typeof db) => unknown) => fn(db));
  return db;
}

describe('WarehousesService', () => {
  let service: WarehousesService;
  let db: ReturnType<typeof mockDb>;
  const inventory = {
    getUnassignedLocationId: jest.fn(),
    syncVariantStock: jest.fn(),
  };

  beforeEach(async () => {
    db = mockDb();
    const moduleRef = await Test.createTestingModule({
      providers: [
        WarehousesService,
        { provide: PrismaService, useValue: db },
        { provide: InventoryService, useValue: inventory },
      ],
    }).compile();
    service = moduleRef.get(WarehousesService);
  });

  afterEach(() => jest.clearAllMocks());

  const base = {
    code: 'CTG-01',
    name: 'Chattogram',
    type: 'PHYSICAL' as const,
    priority: 0,
    isActive: true,
  };

  describe('create', () => {
    it('makes it the only default and opens its UNASSIGNED location', async () => {
      await service.create({ ...base, isDefault: true });
      expect(db.warehouse.updateMany).toHaveBeenCalledWith({
        where: { isDefault: true },
        data: { isDefault: false },
      });
      expect(inventory.getUnassignedLocationId).toHaveBeenCalledWith(
        db,
        'wh-new',
      );
    });

    it('refuses an inactive default', async () => {
      await expect(
        service.create({ ...base, isDefault: true, isActive: false }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    it("won't unset the current default", async () => {
      db.warehouse.findUnique.mockResolvedValue({ ...WH, isDefault: true });
      await expect(
        service.update('wh-1', { isDefault: false }),
      ).rejects.toThrow(BadRequestException);
    });

    it("won't deactivate the default", async () => {
      db.warehouse.findUnique.mockResolvedValue({ ...WH, isDefault: true });
      await expect(service.update('wh-1', { isActive: false })).rejects.toThrow(
        BadRequestException,
      );
    });

    it("won't deactivate with open documents", async () => {
      db.purchaseOrder.count.mockResolvedValue(1);
      await expect(service.update('wh-1', { isActive: false })).rejects.toThrow(
        ConflictException,
      );
      expect(db.warehouse.update).not.toHaveBeenCalled();
    });

    it('re-syncs storefront stock when it stops being sellable', async () => {
      db.inventoryLevel.findMany.mockResolvedValue([
        { variantId: 'v1' },
        { variantId: 'v2' },
      ]);
      await service.update('wh-1', { type: 'VIRTUAL_DAMAGE' });
      expect(inventory.syncVariantStock).toHaveBeenCalledTimes(2);
    });

    it("doesn't re-sync when sellability is unchanged", async () => {
      await service.update('wh-1', { name: 'Dhaka Central', type: 'STORE' });
      expect(inventory.syncVariantStock).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it("won't delete the default", async () => {
      db.warehouse.findUnique.mockResolvedValue({ ...WH, isDefault: true });
      await expect(service.remove('wh-1')).rejects.toThrow(ConflictException);
    });

    it('refuses a warehouse with stock or history', async () => {
      db.inventoryLevel.count.mockResolvedValue(3);
      await expect(service.remove('wh-1')).rejects.toThrow(ConflictException);
      expect(db.warehouse.delete).not.toHaveBeenCalled();
    });

    it('deletes an unused warehouse with its UNASSIGNED location', async () => {
      await expect(service.remove('wh-1')).resolves.toEqual({
        data: { id: 'wh-1', result: 'deleted' },
      });
      expect(db.storageLocation.deleteMany).toHaveBeenCalledWith({
        where: { warehouseId: 'wh-1' },
      });
      expect(db.warehouse.delete).toHaveBeenCalledWith({
        where: { id: 'wh-1' },
      });
    });
  });
});
