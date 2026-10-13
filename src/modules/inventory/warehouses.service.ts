import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Decimal,
  PrismaClientKnownRequestError,
} from '@prisma/client/runtime/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma/client';
import type { WarehouseType } from 'src/generated/prisma/enums';
import {
  InventoryService,
  SELLABLE_WAREHOUSE_TYPES,
  UNASSIGNED_LOCATION_CODE,
} from './inventory.service';
import {
  pageMeta,
  runDocumentTx,
  toVariantLine,
  VARIANT_LINE_SELECT,
} from './documents.util';
import {
  CreateWarehouseDto,
  UpdateWarehouseDto,
  WarehouseStockQueryDto,
} from './dto/warehouse.dto';

export interface WarehouseCounts {
  locations: number; // excluding UNASSIGNED
  variantsStocked: number; // levels with onHand > 0
  unitsOnHand: number;
  stockValue: Decimal; // Σ totalCost
}

const isSellable = (type: WarehouseType, isActive: boolean) =>
  isActive && (SELLABLE_WAREHOUSE_TYPES as readonly string[]).includes(type);

@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  async findAll() {
    const warehouses = await this.prisma.warehouse.findMany({
      orderBy: [{ isDefault: 'desc' }, { priority: 'desc' }, { name: 'asc' }],
    });
    const counts = await this.countsFor(warehouses.map((w) => w.id));
    return {
      data: warehouses.map((w) => ({ ...w, counts: counts.get(w.id)! })),
    };
  }

  async findOne(id: string) {
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id } });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    const counts = await this.countsFor([id]);
    return { data: { ...warehouse, counts: counts.get(id)! } };
  }

  async create(dto: CreateWarehouseDto) {
    if (dto.isDefault && !dto.isActive) {
      throw new BadRequestException("The default warehouse can't be inactive");
    }
    try {
      const warehouse = await runDocumentTx(this.prisma, async (tx) => {
        if (dto.isDefault) {
          await tx.warehouse.updateMany({
            where: { isDefault: true },
            data: { isDefault: false },
          });
        }
        const created = await tx.warehouse.create({ data: dto });
        await this.inventory.getUnassignedLocationId(tx, created.id);
        return created;
      });
      return this.findOne(warehouse.id);
    } catch (e) {
      this.rethrowUnique(e);
    }
  }

  async update(id: string, dto: UpdateWarehouseDto) {
    try {
      await runDocumentTx(this.prisma, async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "warehouses" WHERE "id" = ${id} FOR UPDATE`;
        const current = await tx.warehouse.findUnique({ where: { id } });
        if (!current) throw new NotFoundException('Warehouse not found');

        const isActive = dto.isActive ?? current.isActive;
        const isDefault = dto.isDefault ?? current.isDefault;
        const type = dto.type ?? current.type;
        if (current.isDefault && dto.isDefault === false) {
          throw new BadRequestException(
            'Make another warehouse the default instead',
          );
        }
        if (isDefault && !isActive) {
          throw new BadRequestException(
            "The default warehouse can't be inactive",
          );
        }
        if (current.isActive && !isActive) {
          await this.assertNoOpenDocuments(tx, id);
        }
        if (isDefault && !current.isDefault) {
          await tx.warehouse.updateMany({
            where: { isDefault: true },
            data: { isDefault: false },
          });
        }

        // code is z.never(), so always undefined here.
        await tx.warehouse.update({
          where: { id },
          data: { ...dto, code: undefined },
        });

        // Storefront stock only counts active sellable warehouses.
        if (
          isSellable(current.type, current.isActive) !==
          isSellable(type, isActive)
        ) {
          const levels = await tx.inventoryLevel.findMany({
            where: { warehouseId: id },
            select: { variantId: true },
          });
          for (const level of levels) {
            await this.inventory.syncVariantStock(tx, level.variantId);
          }
        }
      });
      return this.findOne(id);
    } catch (e) {
      this.rethrowUnique(e);
    }
  }

  async remove(id: string) {
    await runDocumentTx(this.prisma, async (tx) => {
      const warehouse = await tx.warehouse.findUnique({
        where: { id },
        select: { isDefault: true },
      });
      if (!warehouse) throw new NotFoundException('Warehouse not found');
      if (warehouse.isDefault) {
        throw new ConflictException("The default warehouse can't be deleted");
      }

      const inUse = await Promise.all([
        tx.inventoryLevel.count({ where: { warehouseId: id } }),
        tx.storageLocation.count({
          where: { warehouseId: id, code: { not: UNASSIGNED_LOCATION_CODE } },
        }),
        tx.inventoryMovement.count({
          where: { OR: [{ sourceWarehouseId: id }, { destWarehouseId: id }] },
        }),
        tx.inventoryBatch.count({ where: { warehouseId: id } }),
        tx.purchaseOrderItem.count({ where: { warehouseId: id } }),
        tx.inventoryTransfer.count({
          where: { OR: [{ fromWarehouseId: id }, { toWarehouseId: id }] },
        }),
        tx.stockAdjustmentItem.count({ where: { warehouseId: id } }),
      ]);
      if (inUse.some((n) => n > 0)) {
        throw new ConflictException(
          'This warehouse has stock, racks or documents. Deactivate it instead.',
        );
      }

      // Only its empty UNASSIGNED location is left.
      await tx.storageLocation.deleteMany({ where: { warehouseId: id } });
      await tx.warehouse.delete({ where: { id } });
    });
    return { data: { id, result: 'deleted' as const } };
  }

  async stock(id: string, query: WarehouseStockQueryDto) {
    const { page, limit, search } = query;
    const exists = await this.prisma.warehouse.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Warehouse not found');

    const where: Prisma.InventoryLevelWhereInput = {
      warehouseId: id,
      ...(search && {
        variant: {
          OR: [
            { sku: { contains: search, mode: 'insensitive' } },
            { product: { name: { contains: search, mode: 'insensitive' } } },
          ],
        },
      }),
    };
    const [total, levels] = await Promise.all([
      this.prisma.inventoryLevel.count({ where }),
      this.prisma.inventoryLevel.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ variant: { sku: 'asc' } }],
        select: {
          id: true,
          onHand: true,
          reserved: true,
          available: true,
          incoming: true,
          damaged: true,
          unitCost: true,
          totalCost: true,
          updatedAt: true,
          variant: { select: VARIANT_LINE_SELECT },
          defaultLocation: { select: { id: true, code: true } },
        },
      }),
    ]);
    return {
      data: levels.map((l) => ({ ...l, variant: toVariantLine(l.variant) })),
      meta: pageMeta(total, page, limit),
    };
  }

  private async countsFor(
    ids: string[],
  ): Promise<Map<string, WarehouseCounts>> {
    const [locations, stocked, totals] = await Promise.all([
      this.prisma.storageLocation.groupBy({
        by: ['warehouseId'],
        where: {
          warehouseId: { in: ids },
          code: { not: UNASSIGNED_LOCATION_CODE },
        },
        _count: { _all: true },
      }),
      this.prisma.inventoryLevel.groupBy({
        by: ['warehouseId'],
        where: { warehouseId: { in: ids }, onHand: { gt: 0 } },
        _count: { _all: true },
      }),
      this.prisma.inventoryLevel.groupBy({
        by: ['warehouseId'],
        where: { warehouseId: { in: ids } },
        _sum: { onHand: true, totalCost: true },
      }),
    ]);
    return new Map(
      ids.map((id) => {
        const sum = totals.find((t) => t.warehouseId === id)?._sum;
        return [
          id,
          {
            locations:
              locations.find((l) => l.warehouseId === id)?._count._all ?? 0,
            variantsStocked:
              stocked.find((s) => s.warehouseId === id)?._count._all ?? 0,
            unitsOnHand: sum?.onHand ?? 0,
            stockValue: sum?.totalCost ?? new Decimal(0),
          },
        ];
      }),
    );
  }

  private async assertNoOpenDocuments(
    tx: Prisma.TransactionClient,
    id: string,
  ) {
    const [pos, transfers] = await Promise.all([
      tx.purchaseOrder.count({
        where: {
          status: { in: ['SUBMITTED', 'CONFIRMED', 'PARTIAL'] },
          items: { some: { warehouseId: id } },
        },
      }),
      tx.inventoryTransfer.count({
        where: {
          status: { in: ['PENDING', 'IN_TRANSIT', 'PARTIAL'] },
          OR: [{ fromWarehouseId: id }, { toWarehouseId: id }],
        },
      }),
    ]);
    if (pos || transfers) {
      throw new ConflictException(
        `This warehouse has ${pos} open purchase order(s) and ${transfers} open transfer(s). Finish or cancel them first.`,
      );
    }
  }

  private rethrowUnique(e: unknown): never {
    if (e instanceof PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ConflictException(
        'A warehouse with this name or code already exists',
      );
    }
    throw e;
  }
}
