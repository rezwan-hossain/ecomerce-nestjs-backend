import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma/client';

import {
  InventoryService,
  UNASSIGNED_LOCATION_CODE,
} from './inventory.service';
import {
  CreateLocationDto,
  LocationQueryDto,
  UpdateLocationDto,
} from './dto/storage-location.dto';

/**
 * Racks / shelves / bins inside a warehouse. Stock on them only changes
 * through InventoryService (movements, rack moves, counts) — never here.
 */
@Injectable()
export class StorageLocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  async findAll(query: LocationQueryDto) {
    const { page, limit, warehouseId, type, parentId, search, isActive } =
      query;

    const where: Prisma.StorageLocationWhereInput = {
      ...(warehouseId && { warehouseId }),
      ...(type && { type }),
      ...(parentId && { parentId }),
      ...(isActive !== undefined && { isActive }),
      ...(search && {
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [total, locations] = await Promise.all([
      this.prisma.storageLocation.count({ where }),
      this.prisma.storageLocation.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ pickSequence: 'asc' }, { code: 'asc' }],
        include: {
          warehouse: { select: { id: true, code: true } },
          parent: { select: { id: true, code: true } },
          _count: {
            select: { locationStocks: { where: { quantity: { gt: 0 } } } },
          },
        },
      }),
    ]);

    // Units per rack for this page in one query.
    const units = await this.prisma.locationStock.groupBy({
      by: ['locationId'],
      where: { locationId: { in: locations.map((l) => l.id) } },
      _sum: { quantity: true },
    });
    const unitsById = new Map(
      units.map((u) => [u.locationId, u._sum.quantity ?? 0]),
    );

    return {
      data: locations.map(({ _count, ...l }) => ({
        ...l,
        variantCount: _count.locationStocks,
        totalUnits: unitsById.get(l.id) ?? 0,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  /** The rack plus everything on it ("what's on A-03?"). */
  async findOne(id: string) {
    const location = await this.prisma.storageLocation.findUnique({
      where: { id },
      include: {
        warehouse: { select: { id: true, code: true, name: true } },
        parent: { select: { id: true, code: true } },
        children: {
          select: { id: true, code: true, type: true, isActive: true },
          orderBy: { code: 'asc' },
        },
        locationStocks: {
          where: { quantity: { gt: 0 } },
          orderBy: { inventoryLevel: { variant: { sku: 'asc' } } },
          select: {
            quantity: true,
            updatedAt: true,
            inventoryLevel: {
              select: {
                defaultLocationId: true,
                variant: {
                  select: {
                    id: true,
                    sku: true,
                    product: { select: { id: true, name: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!location) throw new NotFoundException('Location not found');

    const { locationStocks, ...rest } = location;
    return {
      data: {
        ...rest,
        totalUnits: locationStocks.reduce((sum, s) => sum + s.quantity, 0),
        stock: locationStocks.map((s) => ({
          variant: s.inventoryLevel.variant,
          quantity: s.quantity,
          isDefaultRack: s.inventoryLevel.defaultLocationId === id,
          updatedAt: s.updatedAt,
        })),
      },
    };
  }

  async create(dto: CreateLocationDto) {
    const warehouseId =
      dto.warehouseId ??
      (await this.inventory.getDefaultWarehouseId(this.prisma));

    if (dto.parentId) {
      await this.assertParent(dto.parentId, warehouseId);
    }

    try {
      const location = await this.prisma.storageLocation.create({
        data: {
          warehouseId,
          code: dto.code,
          name: dto.name,
          type: dto.type,
          parentId: dto.parentId,
          isPickable: dto.isPickable,
          pickSequence: dto.pickSequence,
          note: dto.note,
        },
      });
      return { message: 'Location created', data: location };
    } catch (e) {
      throw this.translate(e, dto.code);
    }
  }

  async update(id: string, dto: UpdateLocationDto) {
    const location = await this.prisma.storageLocation.findUnique({
      where: { id },
      select: { id: true, code: true, warehouseId: true, isActive: true },
    });
    if (!location) throw new NotFoundException('Location not found');

    if (location.code === UNASSIGNED_LOCATION_CODE) {
      if (
        (dto.code && dto.code !== UNASSIGNED_LOCATION_CODE) ||
        dto.isActive === false
      ) {
        throw new BadRequestException(
          'The UNASSIGNED location cannot be renamed or deactivated',
        );
      }
    }

    if (dto.parentId) {
      if (dto.parentId === id) {
        throw new BadRequestException('A location cannot be its own parent');
      }
      await this.assertParent(dto.parentId, location.warehouseId);
      await this.assertNoCycle(id, dto.parentId);
    }

    // Deactivating a rack that still holds stock would hide it from
    // put-away while units sit on it — empty it first.
    if (dto.isActive === false && location.isActive) {
      const held = await this.unitsOn(id);
      if (held > 0) {
        throw new ConflictException(
          `Location "${location.code}" still holds ${held} unit(s); move them before deactivating`,
        );
      }
    }

    try {
      const updated = await this.prisma.storageLocation.update({
        where: { id },
        data: dto,
      });
      return { message: 'Location updated', data: updated };
    } catch (e) {
      throw this.translate(e, dto.code ?? location.code);
    }
  }

  /**
   * Only for locations created by mistake: anything that ever held stock
   * is referenced by the ledger and must be deactivated instead.
   */
  async remove(id: string) {
    const location = await this.prisma.storageLocation.findUnique({
      where: { id },
      select: { code: true },
    });
    if (!location) throw new NotFoundException('Location not found');
    if (location.code === UNASSIGNED_LOCATION_CODE) {
      throw new BadRequestException(
        'The UNASSIGNED location cannot be deleted',
      );
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // Empty rows left behind by past stock (quantity 0) don't count.
        await tx.locationStock.deleteMany({
          where: { locationId: id, quantity: 0 },
        });
        await tx.storageLocation.delete({ where: { id } });
      });
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new ConflictException(
          `Location "${location.code}" has stock, movement history or child locations. Deactivate it instead (isActive: false).`,
        );
      }
      throw e;
    }
    return { message: 'Location deleted' };
  }

  // ═════════════════════════════════════════════════
  //   HELPERS
  // ═════════════════════════════════════════════════

  private async unitsOn(locationId: string) {
    const agg = await this.prisma.locationStock.aggregate({
      where: { locationId },
      _sum: { quantity: true },
    });
    return agg._sum.quantity ?? 0;
  }

  private async assertParent(parentId: string, warehouseId: string) {
    const parent = await this.prisma.storageLocation.findUnique({
      where: { id: parentId },
      select: { warehouseId: true },
    });
    if (!parent) throw new NotFoundException('Parent location not found');
    if (parent.warehouseId !== warehouseId) {
      throw new BadRequestException(
        'Parent location belongs to a different warehouse',
      );
    }
  }

  /** Walks up from the new parent; reaching `id` would create a loop. */
  private async assertNoCycle(id: string, parentId: string) {
    let current: string | null = parentId;
    for (let depth = 0; current && depth < 50; depth++) {
      if (current === id) {
        throw new BadRequestException(
          'That parent would create a loop in the location tree',
        );
      }
      const next: { parentId: string | null } | null =
        await this.prisma.storageLocation.findUnique({
          where: { id: current },
          select: { parentId: true },
        });
      current = next?.parentId ?? null;
    }
  }

  private translate(e: unknown, code: string) {
    if (e instanceof PrismaClientKnownRequestError) {
      if (e.code === 'P2002') {
        return new ConflictException(
          `Location "${code}" already exists in this warehouse`,
        );
      }
      if (e.code === 'P2003') {
        return new BadRequestException('Warehouse or parent not found');
      }
    }
    return e;
  }
}
