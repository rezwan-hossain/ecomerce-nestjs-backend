import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  Decimal,
  PrismaClientKnownRequestError,
} from '@prisma/client/runtime/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { dateRangeFilter } from 'src/common/utils/date-range.util';
import { Prisma } from 'src/generated/prisma/client';
import type {
  MovementDirection,
  MovementType,
  ReferenceType,
  ReservationStatus,
} from 'src/generated/prisma/enums';
import { ProductVariantWhereInput } from 'src/generated/prisma/models/ProductVariant';
import { InventoryMovementWhereInput } from 'src/generated/prisma/models/InventoryMovement';

import { planPick as planPickLegs, type PickLeg } from './floor-plan/pick-plan';
import { nextDocumentNumber } from './documents.util';
import {
  AdjustStockItemDto,
  BulkAdjustStockDto,
  InventoryQueryDto,
  LocationCountDto,
  LocationMoveDto,
  MoveStockDto,
  MovementQueryDto,
  ReceiveStockDto,
  SetDefaultLocationDto,
  StockCountDto,
  UpdateThresholdDto,
} from './dto/inventory.dto';

/** A change to onHand at one warehouse (IN or OUT movement types only). */
export interface StockChange {
  variantId: string;
  warehouseId?: string | null; // defaults to the default warehouse
  // Rack to put away to (IN) or take from (OUT). Omitted: IN goes to the
  // variant's default rack (else UNASSIGNED); OUT is auto-picked.
  locationId?: string | null;
  type: MovementType;
  quantity: number; // always positive; the type decides the direction
  unitCost?: Decimal.Value | null; // inbound: feeds the weighted average cost
  referenceType?: ReferenceType | null;
  referenceId?: string | null;
  sourceWarehouseId?: string | null;
  destWarehouseId?: string | null;
  batchId?: string | null;
  note?: string | null;
  userId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Goods bought from a supplier. Each receipt becomes its own InventoryBatch
 * (traceable to the supplier) plus a PURCHASE_RECEIVED movement.
 */
export interface StockReceipt {
  variantId: string;
  warehouseId?: string | null; // defaults to the default warehouse
  locationId?: string | null; // put-away rack; same rules as StockChange
  quantity: number;
  unitCost?: Decimal.Value | null;
  supplierId?: string | null;
  batchNumber?: string | null; // supplier's lot number; generated if omitted
  manufacturedAt?: Date | null;
  expiresAt?: Date | null;
  reference?: string | null; // supplier invoice / delivery note number
  note?: string | null;
  userId?: string | null;
}

export interface LocationMove {
  variantId: string;
  warehouseId?: string | null; // defaults to the default warehouse
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  note?: string | null;
  userId?: string | null;
}

/** A bin → bin move of one inventory level's stock (rack map). */
export interface LocationTransfer {
  inventoryLevelId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  makeDefault?: boolean; // also make the destination the default (if pickable)
  note?: string | null;
  userId?: string | null;
}

/** One counted line of a bin count. */
export interface CountLine {
  inventoryLevelId: string;
  countedQty: number;
}

/** Roles allowed to approve (and so apply) stock adjustments. */
const ADJUSTMENT_APPROVER_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const;

/** Location types that never hold stock directly. */
const NON_STOCK_LOCATION_TYPES = ['ZONE', 'AISLE'] as const;

export interface ReservationLine {
  variantId: string;
  quantity: number;
  orderItemId?: string | null;
}

export type StockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

export const MOVEMENT_DIRECTION: Record<MovementType, MovementDirection> = {
  PURCHASE_RECEIVED: 'IN',
  RETURN_RESTOCKED: 'IN',
  ADJUSTMENT_INCREASE: 'IN',
  TRANSFER_IN: 'IN',
  INITIAL_STOCK: 'IN',
  SALE: 'OUT',
  ADJUSTMENT_DECREASE: 'OUT',
  TRANSFER_OUT: 'OUT',
  DAMAGED: 'OUT',
  LOST: 'OUT',
  EXPIRED: 'OUT',
  SAMPLE: 'OUT',
  WRITE_OFF: 'OUT',
  RESERVATION_CREATED: 'INTERNAL',
  RESERVATION_RELEASED: 'INTERNAL',
  RESERVATION_EXPIRED: 'INTERNAL',
  LOCATION_MOVE: 'INTERNAL',
};

/** Code of the per-warehouse catch-all location for stock with no rack. */
export const UNASSIGNED_LOCATION_CODE = 'UNASSIGNED';

/** Warehouses whose `available` counts towards storefront stock. */
const SELLABLE_WAREHOUSE_TYPES = ['PHYSICAL', 'STORE'] as const;

/** How long an order may hold stock before the expiry sweep frees it. */
export const RESERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const VARIANT_STOCK_SELECT = {
  id: true,
  sku: true,
  stock: true,
  lowStockThreshold: true,
  isActive: true,
  updatedAt: true,
  product: { select: { id: true, name: true, slug: true } },
  optionValues: {
    select: {
      optionValue: {
        select: { value: true, option: { select: { name: true } } },
      },
    },
  },
  inventoryLevels: {
    select: {
      warehouseId: true,
      onHand: true,
      reserved: true,
      available: true,
      incoming: true,
      damaged: true,
      unitCost: true,
      warehouse: { select: { code: true, name: true, type: true } },
      defaultLocation: { select: { id: true, code: true } },
      locationStocks: {
        where: { quantity: { gt: 0 } },
        select: {
          quantity: true,
          location: { select: { id: true, code: true, name: true } },
        },
        orderBy: { location: { code: 'asc' } },
      },
    },
    orderBy: { warehouse: { priority: 'desc' } },
  },
} satisfies Prisma.ProductVariantSelect;

type VariantStockRow = Prisma.ProductVariantGetPayload<{
  select: typeof VARIANT_STOCK_SELECT;
}>;

type LevelRow = {
  id: string;
  warehouseId: string;
  onHand: number;
  reserved: number;
  unitCost: Decimal;
  defaultLocationId: string | null;
};

/** Part of a stock change that hits one rack. */
type Leg = PickLeg;

type Movement = Awaited<
  ReturnType<Prisma.TransactionClient['inventoryMovement']['create']>
>;

/** "RCV-20261006-1A2B3C4D" — used when the supplier gives no lot number. */
export function generateBatchNumber(date = new Date()): string {
  const day = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `RCV-${day}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export function stockStatusOf(v: {
  stock: number;
  lowStockThreshold: number;
}): StockStatus {
  if (v.stock <= 0) return 'OUT_OF_STOCK';
  if (v.stock <= v.lowStockThreshold) return 'LOW_STOCK';
  return 'IN_STOCK';
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // ═════════════════════════════════════════════════
  //   CORE — used by orders/products inside their transactions
  // ═════════════════════════════════════════════════

  /**
   * The ONLY way onHand should change. Atomically updates one
   * InventoryLevel and its per-rack LocationStock rows, writes one ledger
   * row per rack touched and re-syncs ProductVariant.stock. Outbound
   * changes are conditional on `available >= quantity`, so they can never
   * eat into reserved stock or oversell under concurrency; DB CHECKs are
   * the final guard.
   */
  async applyMovement(
    tx: Prisma.TransactionClient,
    change: StockChange,
  ): Promise<Movement[]> {
    const { variantId, quantity, type } = change;
    const direction = MOVEMENT_DIRECTION[type];
    if (direction === 'INTERNAL') {
      throw new BadRequestException(
        `${type} doesn't change onHand; use the reservation / location-move methods`,
      );
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }

    const warehouseId =
      change.warehouseId ?? (await this.getDefaultWarehouseId(tx));
    const level = await this.lockLevel(tx, variantId, warehouseId);

    if (direction === 'OUT' && level.onHand - level.reserved < quantity) {
      throw new BadRequestException(
        `Not enough stock for SKU "${await this.skuOf(tx, variantId)}": ${level.onHand - level.reserved} available, ${quantity} requested`,
      );
    }

    // WHERE inside the warehouse — resolved before anything is written.
    const legs: Leg[] =
      direction === 'IN'
        ? [
            {
              locationId: await this.resolvePutaway(
                tx,
                level,
                change.locationId,
              ),
              quantity,
            },
          ]
        : await this.planPick(tx, level, quantity, change.locationId);

    const onHandAfter =
      direction === 'IN' ? level.onHand + quantity : level.onHand - quantity;

    // Weighted average cost: only inbound movements with a known cost move it.
    let unitCost = new Decimal(level.unitCost);
    const movementUnitCost =
      change.unitCost != null ? new Decimal(change.unitCost) : unitCost;
    if (direction === 'IN' && change.unitCost != null && onHandAfter > 0) {
      unitCost = unitCost
        .mul(level.onHand)
        .plus(movementUnitCost.mul(quantity))
        .div(onHandAfter)
        .toDecimalPlaces(4);
    }

    await tx.inventoryLevel.update({
      where: { id: level.id },
      data: {
        onHand: onHandAfter,
        available: onHandAfter - level.reserved,
        // Damaged goods leave sellable onHand but stay tracked aside.
        ...(type === 'DAMAGED' && { damaged: { increment: quantity } }),
        unitCost,
        totalCost: unitCost.mul(onHandAfter),
        version: { increment: 1 },
      },
    });

    const movements: Movement[] = [];
    let onHand = level.onHand;
    for (const leg of legs) {
      const legAfter =
        direction === 'IN' ? onHand + leg.quantity : onHand - leg.quantity;
      await this.changeLocationStock(
        tx,
        level,
        leg.locationId,
        direction === 'IN' ? leg.quantity : -leg.quantity,
      );
      movements.push(
        await tx.inventoryMovement.create({
          data: {
            inventoryLevelId: level.id,
            type,
            direction,
            quantity: leg.quantity,
            onHandBefore: onHand,
            onHandAfter: legAfter,
            unitCost: movementUnitCost,
            totalCost: movementUnitCost.mul(leg.quantity),
            referenceType: change.referenceType ?? null,
            referenceId: change.referenceId ?? null,
            sourceWarehouseId: change.sourceWarehouseId ?? null,
            destWarehouseId: change.destWarehouseId ?? null,
            ...(direction === 'IN'
              ? { toLocationId: leg.locationId }
              : { fromLocationId: leg.locationId }),
            batchId: change.batchId ?? null,
            note: change.note ?? null,
            performedByUserId: change.userId ?? null,
            metadata: change.metadata,
          },
        }),
      );
      onHand = legAfter;
    }

    await this.syncVariantStock(tx, variantId);
    return movements;
  }

  /**
   * Sets stock to an exact counted number (stock take / admin edit) and
   * records the difference as an adjustment. With `locationId` the count is
   * for that one rack; without it, for the whole warehouse. Returns null
   * when nothing changed.
   */
  async setStock(
    tx: Prisma.TransactionClient,
    variantId: string,
    counted: number,
    opts: {
      warehouseId?: string | null;
      locationId?: string | null;
      note?: string | null;
      userId?: string | null;
    } = {},
  ): Promise<Movement[] | null> {
    const warehouseId =
      opts.warehouseId ?? (await this.getDefaultWarehouseId(tx));
    const level = await this.lockLevel(tx, variantId, warehouseId);

    let current = level.onHand;
    if (opts.locationId) {
      await this.assertLocationInWarehouse(tx, opts.locationId, warehouseId);
      const row = await tx.locationStock.findUnique({
        where: {
          inventoryLevelId_locationId: {
            inventoryLevelId: level.id,
            locationId: opts.locationId,
          },
        },
        select: { quantity: true },
      });
      current = row?.quantity ?? 0;
    }

    const delta = counted - current;
    if (delta === 0) return null;

    return this.applyMovement(tx, {
      variantId,
      warehouseId,
      locationId: opts.locationId,
      type: delta > 0 ? 'ADJUSTMENT_INCREASE' : 'ADJUSTMENT_DECREASE',
      quantity: Math.abs(delta),
      referenceType: 'ADJUSTMENT',
      note: opts.note,
      userId: opts.userId,
    });
  }

  /**
   * Opens the inventory of a freshly created variant: creates its level at
   * the default warehouse and, if it was created with stock, books that as
   * INITIAL_STOCK (which also re-syncs ProductVariant.stock). `unitCost`
   * seeds the average cost — even with zero stock, so later restocks
   * recorded without a cost still get a sensible value. With `supplierId`
   * the stock is booked as received from that supplier (a batch +
   * PURCHASE_RECEIVED) instead of INITIAL_STOCK.
   */
  async recordInitialStock(
    tx: Prisma.TransactionClient,
    variant: { id: string; stock: number },
    opts: {
      unitCost?: Decimal.Value | null;
      supplierId?: string | null;
      userId?: string | null;
    } = {},
  ) {
    const warehouseId = await this.getDefaultWarehouseId(tx);
    const level = await this.ensureLevel(tx, variant.id, warehouseId);
    if (variant.stock <= 0) {
      if (opts.unitCost != null) {
        await tx.inventoryLevel.update({
          where: { id: level.id },
          data: { unitCost: new Decimal(opts.unitCost) },
        });
      }
      return null;
    }
    if (opts.supplierId) {
      return this.receiveStock(tx, {
        variantId: variant.id,
        warehouseId,
        quantity: variant.stock,
        unitCost: opts.unitCost,
        supplierId: opts.supplierId,
        note: 'Opening stock',
        userId: opts.userId,
      });
    }
    // Lands on UNASSIGNED until a default rack is set.
    return this.applyMovement(tx, {
      variantId: variant.id,
      warehouseId,
      type: 'INITIAL_STOCK',
      quantity: variant.stock,
      unitCost: opts.unitCost,
      userId: opts.userId,
    });
  }

  /**
   * Books goods received from a supplier: creates the batch, then a
   * PURCHASE_RECEIVED movement linked to it (which updates onHand, the
   * average cost, the rack and ProductVariant.stock).
   */
  async receiveStock(
    tx: Prisma.TransactionClient,
    receipt: StockReceipt,
  ): Promise<Movement[]> {
    const { variantId, quantity, reference } = receipt;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }
    if (receipt.supplierId) {
      await this.assertActiveSupplier(tx, receipt.supplierId);
    }

    const warehouseId =
      receipt.warehouseId ?? (await this.getDefaultWarehouseId(tx));
    const batchNumber = receipt.batchNumber ?? generateBatchNumber();
    const duplicate = await tx.inventoryBatch.findUnique({
      where: {
        variantId_warehouseId_batchNumber: {
          variantId,
          warehouseId,
          batchNumber,
        },
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(
        `Batch "${batchNumber}" was already received for SKU "${await this.skuOf(tx, variantId)}" at this warehouse`,
      );
    }

    // Locks the level first, so a missing variant/warehouse is a 404.
    await this.lockLevel(tx, variantId, warehouseId);
    const unitCost =
      receipt.unitCost != null ? new Decimal(receipt.unitCost) : null;
    const batch = await tx.inventoryBatch.create({
      data: {
        variantId,
        warehouseId,
        batchNumber,
        quantity,
        initialQty: quantity,
        unitCost,
        manufacturedAt: receipt.manufacturedAt ?? null,
        expiresAt: receipt.expiresAt ?? null,
        receivedAt: new Date(),
        supplierId: receipt.supplierId ?? null,
        note: reference ?? null,
      },
    });

    return this.applyMovement(tx, {
      variantId,
      warehouseId,
      locationId: receipt.locationId,
      type: 'PURCHASE_RECEIVED',
      quantity,
      unitCost,
      batchId: batch.id,
      note:
        [receipt.note, reference && `Ref: ${reference}`]
          .filter(Boolean)
          .join(' — ') || null,
      userId: receipt.userId,
      metadata: reference ? { reference } : undefined,
    });
  }

  // ─── Racks ──────────────────────────────────────

  /**
   * Moves units between two racks of the same warehouse. onHand, reserved
   * and the storefront stock are unchanged — reservations are held at
   * warehouse level, so reserved units can be moved too.
   */
  async moveStock(tx: Prisma.TransactionClient, move: LocationMove) {
    const { variantId, fromLocationId, toLocationId, quantity } = move;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }
    if (fromLocationId === toLocationId) {
      throw new BadRequestException('Source and destination rack are the same');
    }

    const warehouseId =
      move.warehouseId ?? (await this.getDefaultWarehouseId(tx));
    const level = await this.lockLevel(tx, variantId, warehouseId);
    // Moving OUT of an inactive rack is allowed (that's how it's emptied).
    await this.assertLocationInWarehouse(tx, fromLocationId, warehouseId, {
      allowInactive: true,
    });
    await this.assertLocationInWarehouse(tx, toLocationId, warehouseId);

    await this.changeLocationStock(tx, level, fromLocationId, -quantity);
    await this.changeLocationStock(tx, level, toLocationId, quantity);

    return tx.inventoryMovement.create({
      data: {
        inventoryLevelId: level.id,
        type: 'LOCATION_MOVE',
        direction: 'INTERNAL',
        quantity,
        onHandBefore: level.onHand,
        onHandAfter: level.onHand,
        fromLocationId,
        toLocationId,
        note: move.note ?? null,
        performedByUserId: move.userId ?? null,
      },
    });
  }

  /** Sets (or clears, with null) the rack a variant normally lives on. */
  async setDefaultLocation(
    tx: Prisma.TransactionClient,
    variantId: string,
    locationId: string | null,
    warehouseId?: string | null,
  ) {
    const whId = warehouseId ?? (await this.getDefaultWarehouseId(tx));
    if (locationId) await this.assertLocationInWarehouse(tx, locationId, whId);
    const level = await this.lockLevel(tx, variantId, whId);
    return tx.inventoryLevel.update({
      where: { id: level.id },
      data: { defaultLocationId: locationId },
      select: {
        variantId: true,
        warehouseId: true,
        defaultLocation: { select: { id: true, code: true, name: true } },
      },
    });
  }

  /**
   * Moves units of one inventory level from one location to another in the
   * same warehouse (bin → bin on the rack map). onHand is unchanged; writes
   * one LOCATION_MOVE. Unlike moveStock, the destination must be a leaf
   * (stock lives in bins, not on racks that have bins).
   */
  async moveBetweenLocations(
    tx: Prisma.TransactionClient,
    move: LocationTransfer,
  ) {
    const { inventoryLevelId, fromLocationId, toLocationId, quantity } = move;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new BadRequestException('Quantity must be a positive integer');
    }
    if (fromLocationId === toLocationId) {
      throw new BadRequestException(
        'Source and destination are the same location',
      );
    }

    const level = await this.lockLevelById(tx, inventoryLevelId);
    const locations = await tx.storageLocation.findMany({
      where: { id: { in: [fromLocationId, toLocationId] } },
      select: {
        id: true,
        code: true,
        type: true,
        warehouseId: true,
        isActive: true,
        isPickable: true,
        _count: { select: { children: true } },
      },
    });
    const from = locations.find((l) => l.id === fromLocationId);
    const to = locations.find((l) => l.id === toLocationId);
    if (!from) throw new NotFoundException('Source location not found');
    if (!to) throw new NotFoundException('Destination location not found');
    for (const loc of [from, to]) {
      if (loc.warehouseId !== level.warehouseId) {
        throw new BadRequestException(
          `${loc.code} is in a different warehouse from this stock`,
        );
      }
    }
    if (!to.isActive) {
      throw new BadRequestException(`${to.code} is inactive`);
    }
    if (
      to._count.children > 0 ||
      (NON_STOCK_LOCATION_TYPES as readonly string[]).includes(to.type)
    ) {
      throw new BadRequestException(
        `${to.code} doesn't hold stock directly. Pick one of its bins.`,
      );
    }

    const source = await tx.locationStock.findUnique({
      where: {
        inventoryLevelId_locationId: {
          inventoryLevelId,
          locationId: fromLocationId,
        },
      },
      select: { quantity: true },
    });
    const have = source?.quantity ?? 0;
    if (quantity > have) {
      throw new BadRequestException(
        `${from.code} holds ${have} unit(s) of this SKU; can't move ${quantity}`,
      );
    }

    // Source rows are kept at 0 (as everywhere else); remove() cleans them.
    await this.changeLocationStock(tx, level, fromLocationId, -quantity);
    await this.changeLocationStock(tx, level, toLocationId, quantity);
    await tx.inventoryLevel.update({
      where: { id: level.id },
      data: {
        version: { increment: 1 },
        ...(move.makeDefault &&
          to.isPickable && {
            defaultLocationId: toLocationId,
          }),
      },
    });

    const movement = await tx.inventoryMovement.create({
      data: {
        inventoryLevelId: level.id,
        type: 'LOCATION_MOVE',
        direction: 'INTERNAL',
        quantity,
        onHandBefore: level.onHand,
        onHandAfter: level.onHand,
        fromLocationId,
        toLocationId,
        note: move.note ?? null,
        performedByUserId: move.userId ?? null,
      },
    });
    const dest = await tx.locationStock.findUnique({
      where: {
        inventoryLevelId_locationId: {
          inventoryLevelId,
          locationId: toLocationId,
        },
      },
      select: { quantity: true },
    });

    return {
      movementId: movement.id,
      from: { locationId: fromLocationId, quantity: have - quantity },
      to: { locationId: toLocationId, quantity: dest?.quantity ?? quantity },
    };
  }

  // ─── Adjustments ────────────────────────────────

  /**
   * Applies a PENDING or APPROVED adjustment: one movement per non-zero
   * item (at the item's location when it has one), then marks it APPLIED.
   * Cycle-count items with a location are re-based on the location's
   * current quantity, so a count applied later still lands on the counted
   * number.
   */
  async applyAdjustment(
    tx: Prisma.TransactionClient,
    adjustmentId: string,
    userId?: string | null,
  ) {
    // Serialises appliers of the same adjustment.
    await tx.$queryRaw`
      SELECT "id" FROM "stock_adjustments" WHERE "id" = ${adjustmentId} FOR UPDATE`;
    const adjustment = await tx.stockAdjustment.findUnique({
      where: { id: adjustmentId },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    if (!adjustment) throw new NotFoundException('Adjustment not found');
    if (adjustment.status !== 'PENDING' && adjustment.status !== 'APPROVED') {
      throw new ConflictException(
        `${adjustment.adjustmentNumber} is ${adjustment.status.toLowerCase()} and can't be applied`,
      );
    }

    for (const item of adjustment.items) {
      let delta = item.adjustmentQty;
      if (
        adjustment.type === 'CYCLE_COUNT' &&
        item.locationId &&
        item.actualQty !== null
      ) {
        const level = await this.ensureLevel(
          tx,
          item.variantId,
          item.warehouseId,
        );
        const current = await tx.locationStock.findUnique({
          where: {
            inventoryLevelId_locationId: {
              inventoryLevelId: level.id,
              locationId: item.locationId,
            },
          },
          select: { quantity: true },
        });
        const expected = current?.quantity ?? 0;
        delta = item.actualQty - expected;
        if (delta !== item.adjustmentQty || expected !== item.expectedQty) {
          await tx.stockAdjustmentItem.update({
            where: { id: item.id },
            data: { expectedQty: expected, adjustmentQty: delta },
          });
        }
      }
      if (delta === 0) continue;

      await this.applyMovement(tx, {
        variantId: item.variantId,
        warehouseId: item.warehouseId,
        locationId: item.locationId,
        type: delta > 0 ? 'ADJUSTMENT_INCREASE' : 'ADJUSTMENT_DECREASE',
        quantity: Math.abs(delta),
        unitCost: delta > 0 ? item.unitCost : null,
        referenceType: 'ADJUSTMENT',
        referenceId: adjustment.id,
        note: adjustment.note
          ? `${adjustment.adjustmentNumber}: ${adjustment.note}`
          : adjustment.adjustmentNumber,
        userId,
      });
    }

    const now = new Date();
    return tx.stockAdjustment.update({
      where: { id: adjustment.id },
      data: {
        status: 'APPLIED',
        approvedByUserId: adjustment.approvedByUserId ?? userId ?? null,
        approvedAt: adjustment.approvedAt ?? now,
        appliedAt: now,
      },
      select: { id: true, adjustmentNumber: true, status: true },
    });
  }

  /** Whether this user may approve adjustments (ADMIN / SUPER_ADMIN). */
  async canApproveAdjustments(
    tx: Prisma.TransactionClient,
    userId?: string | null,
  ): Promise<boolean> {
    if (!userId) return false;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { role: true, isActive: true },
    });
    return (
      !!user &&
      user.isActive &&
      (ADJUSTMENT_APPROVER_ROLES as readonly string[]).includes(user.role)
    );
  }

  /** "ADJ-2026-00042": next number for the year, serialised by a lock. */
  async nextAdjustmentNumber(
    tx: Prisma.TransactionClient,
    date = new Date(),
  ): Promise<string> {
    return nextDocumentNumber(tx, 'ADJ', date);
  }

  // ─── Reservations ───────────────────────────────

  /**
   * Holds stock for an order. Each line is allocated across sellable
   * warehouses (default first, then by priority), possibly split. All or
   * nothing: throws if any line can't be fully covered, rolling back the
   * caller's transaction.
   */
  async reserveForOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
    lines: ReservationLine[],
    userId?: string | null,
  ) {
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
    const reservations: {
      id: string;
      warehouseId: string;
      quantity: number;
    }[] = [];

    for (const line of lines) {
      // Lock candidate levels in a stable order to avoid deadlocks between
      // concurrent checkouts touching the same variants.
      const levels = await tx.$queryRaw<(LevelRow & { warehouseId: string })[]>`
        SELECT il."id", il."warehouseId", il."onHand", il."reserved", il."unitCost"
        FROM "inventory_levels" il
        JOIN "warehouses" w ON w."id" = il."warehouseId"
        WHERE il."variantId" = ${line.variantId}
          AND w."isActive" = true
          AND w."type"::text IN ('PHYSICAL', 'STORE')
          AND il."onHand" - il."reserved" > 0
        ORDER BY w."isDefault" DESC, w."priority" DESC, il."id"
        FOR UPDATE OF il`;

      let remaining = line.quantity;
      for (const level of levels) {
        if (remaining === 0) break;
        const take = Math.min(remaining, level.onHand - level.reserved);
        remaining -= take;

        const reservedAfter = level.reserved + take;
        await tx.inventoryLevel.update({
          where: { id: level.id },
          data: {
            reserved: reservedAfter,
            available: level.onHand - reservedAfter,
            version: { increment: 1 },
          },
        });
        const reservation = await tx.stockReservation.create({
          data: {
            inventoryLevelId: level.id,
            variantId: line.variantId,
            warehouseId: level.warehouseId,
            orderId,
            orderItemId: line.orderItemId ?? null,
            quantity: take,
            expiresAt,
          },
        });
        await tx.inventoryMovement.create({
          data: {
            inventoryLevelId: level.id,
            type: 'RESERVATION_CREATED',
            direction: 'INTERNAL',
            quantity: take,
            onHandBefore: level.onHand,
            onHandAfter: level.onHand,
            reservedBefore: level.reserved,
            reservedAfter,
            referenceType: 'RESERVATION',
            referenceId: reservation.id,
            performedByUserId: userId ?? null,
            metadata: { orderId },
          },
        });
        reservations.push({
          id: reservation.id,
          warehouseId: level.warehouseId,
          quantity: take,
        });
      }

      if (remaining > 0) {
        const variant = await tx.productVariant.findUnique({
          where: { id: line.variantId },
          select: { sku: true },
        });
        if (!variant)
          throw new NotFoundException(`Variant "${line.variantId}" not found`);
        throw new BadRequestException(
          `Not enough stock for SKU "${variant.sku}": ${line.quantity - remaining} available, ${line.quantity} requested`,
        );
      }

      await this.syncVariantStock(tx, line.variantId);
    }

    return reservations;
  }

  /**
   * Frees an order's ACTIVE reservations (cancel / payment failure / TTL).
   * Orders placed before reservations existed had their stock deducted at
   * checkout with a SALE; those are put back with RETURN_RESTOCKED instead.
   */
  async releaseOrderReservations(
    tx: Prisma.TransactionClient,
    orderId: string,
    opts: {
      status?: Extract<ReservationStatus, 'RELEASED' | 'EXPIRED'>;
      note?: string | null;
      userId?: string | null;
    } = {},
  ) {
    const status = opts.status ?? 'RELEASED';
    const active = await tx.stockReservation.findMany({
      where: { orderId, status: 'ACTIVE' },
      orderBy: { inventoryLevelId: 'asc' },
    });

    if (!active.length) {
      await this.restockLegacySales(tx, orderId, opts);
      return [];
    }

    const touched = new Set<string>();
    for (const r of active) {
      const level = await this.lockLevelById(tx, r.inventoryLevelId);
      const reservedAfter = level.reserved - r.quantity;

      await tx.inventoryLevel.update({
        where: { id: level.id },
        data: {
          reserved: reservedAfter,
          available: level.onHand - reservedAfter,
          version: { increment: 1 },
        },
      });
      await tx.stockReservation.update({
        where: { id: r.id },
        data:
          status === 'EXPIRED'
            ? { status, expiredAt: new Date() }
            : { status, releasedAt: new Date() },
      });
      await tx.inventoryMovement.create({
        data: {
          inventoryLevelId: level.id,
          type:
            status === 'EXPIRED'
              ? 'RESERVATION_EXPIRED'
              : 'RESERVATION_RELEASED',
          direction: 'INTERNAL',
          quantity: r.quantity,
          onHandBefore: level.onHand,
          onHandAfter: level.onHand,
          reservedBefore: level.reserved,
          reservedAfter,
          referenceType: 'RESERVATION',
          referenceId: r.id,
          note: opts.note ?? null,
          performedByUserId: opts.userId ?? null,
          metadata: { orderId },
        },
      });
      touched.add(r.variantId);
    }

    for (const variantId of touched) await this.syncVariantStock(tx, variantId);
    return active;
  }

  /**
   * Converts an order's ACTIVE reservations into actual sales when it
   * ships: onHand and reserved both drop, available is unchanged.
   */
  async commitOrderReservations(
    tx: Prisma.TransactionClient,
    orderId: string,
    userId?: string | null,
  ) {
    // Same order as FloorPlanService.pickRoute, so the route on the map is
    // what gets picked.
    const active = await tx.stockReservation.findMany({
      where: { orderId, status: 'ACTIVE' },
      orderBy: [{ inventoryLevelId: 'asc' }, { id: 'asc' }],
    });

    for (const r of active) {
      const level = await this.lockLevelById(tx, r.inventoryLevelId);
      const onHandAfter = level.onHand - r.quantity;
      const reservedAfter = level.reserved - r.quantity;
      // Which racks the picker takes the units from.
      const legs = await this.planPick(tx, level, r.quantity);

      await tx.inventoryLevel.update({
        where: { id: level.id },
        data: {
          onHand: onHandAfter,
          reserved: reservedAfter,
          totalCost: new Decimal(level.unitCost).mul(onHandAfter),
          version: { increment: 1 },
        },
      });
      await tx.stockReservation.update({
        where: { id: r.id },
        data: { status: 'COMMITTED', committedAt: new Date() },
      });

      // One SALE per rack picked; snapshots step through each leg.
      let onHand = level.onHand;
      let reserved = level.reserved;
      for (const leg of legs) {
        await this.changeLocationStock(
          tx,
          level,
          leg.locationId,
          -leg.quantity,
        );
        await tx.inventoryMovement.create({
          data: {
            inventoryLevelId: level.id,
            type: 'SALE',
            direction: 'OUT',
            quantity: leg.quantity,
            onHandBefore: onHand,
            onHandAfter: onHand - leg.quantity,
            reservedBefore: reserved,
            reservedAfter: reserved - leg.quantity,
            fromLocationId: leg.locationId,
            unitCost: level.unitCost, // COGS at the moment of sale
            totalCost: new Decimal(level.unitCost).mul(leg.quantity),
            referenceType: 'ORDER',
            referenceId: orderId,
            performedByUserId: userId ?? null,
            metadata: { reservationId: r.id },
          },
        });
        onHand -= leg.quantity;
        reserved -= leg.quantity;
      }
    }
    // available didn't change, so ProductVariant.stock needs no sync.
    return active;
  }

  // ─── Helpers usable inside a transaction ────────

  async getDefaultWarehouseId(tx: Prisma.TransactionClient): Promise<string> {
    const warehouse = await tx.warehouse.findFirst({
      where: { isDefault: true, isActive: true },
      select: { id: true },
    });
    if (!warehouse) {
      throw new BadRequestException(
        'No active default warehouse configured — create one first',
      );
    }
    return warehouse.id;
  }

  async ensureLevel(
    tx: Prisma.TransactionClient,
    variantId: string,
    warehouseId: string,
  ) {
    return tx.inventoryLevel.upsert({
      where: { variantId_warehouseId: { variantId, warehouseId } },
      create: { variantId, warehouseId },
      update: {},
      select: { id: true },
    });
  }

  /**
   * Recomputes the storefront stock (sum of available over active sellable
   * warehouses). Carts and pricing read ProductVariant.stock directly.
   */
  async syncVariantStock(tx: Prisma.TransactionClient, variantId: string) {
    await tx.$executeRaw`
      UPDATE "product_variants" SET "stock" = COALESCE((
        SELECT SUM(il."available")
        FROM "inventory_levels" il
        JOIN "warehouses" w ON w."id" = il."warehouseId"
        WHERE il."variantId" = ${variantId}
          AND w."isActive" = true
          AND w."type"::text IN ('PHYSICAL', 'STORE')
      ), 0)
      WHERE "id" = ${variantId}`;
  }

  // ═════════════════════════════════════════════════
  //   ADMIN WRITES
  // ═════════════════════════════════════════════════

  async adjust(dto: AdjustStockItemDto, actedBy?: string) {
    const movements = await this.runInTransaction((tx) =>
      this.applyMovement(tx, this.toStockChange(dto, actedBy)),
    );
    return { message: 'Stock updated', data: movements };
  }

  async receive(dto: ReceiveStockDto, actedBy?: string) {
    const movements = await this.runInTransaction(async (tx) => {
      const created: Movement[] = [];
      for (const item of dto.items) {
        created.push(
          ...(await this.receiveStock(tx, {
            ...item,
            warehouseId: dto.warehouseId,
            supplierId: dto.supplierId,
            reference: dto.reference,
            note: dto.note,
            userId: actedBy,
          })),
        );
      }
      return created;
    });
    return {
      message: `${dto.items.length} item(s) received`,
      data: movements,
    };
  }

  async bulkAdjust(dto: BulkAdjustStockDto, actedBy?: string) {
    const movements = await this.runInTransaction(async (tx) => {
      const created: Movement[] = [];
      for (const item of dto.items) {
        created.push(
          ...(await this.applyMovement(tx, this.toStockChange(item, actedBy))),
        );
      }
      return created;
    });
    return {
      message: `${movements.length} stock movement(s) recorded`,
      data: movements,
    };
  }

  async count(variantId: string, dto: StockCountDto, actedBy?: string) {
    const movements = await this.runInTransaction((tx) =>
      this.setStock(tx, variantId, dto.countedQuantity, {
        warehouseId: dto.warehouseId,
        locationId: dto.locationId,
        note: dto.note ?? 'Stock count',
        userId: actedBy,
      }),
    );
    return {
      message: movements
        ? 'Stock corrected to counted quantity'
        : 'Stock already matches count',
      data: movements,
    };
  }

  /** POST /inventory/locations/:id/moves */
  async moveFromLocation(
    fromLocationId: string,
    dto: LocationMoveDto,
    actedBy?: string,
  ) {
    return this.runInTransaction((tx) =>
      this.moveBetweenLocations(tx, {
        ...dto,
        fromLocationId,
        userId: actedBy,
      }),
    );
  }

  /**
   * POST /inventory/locations/:id/counts — a CYCLE_COUNT adjustment for
   * the lines that differ from what the location holds. Applied right away
   * when `applyNow` and the acting user may approve; otherwise PENDING.
   */
  async countLocation(
    locationId: string,
    dto: LocationCountDto,
    actedBy?: string,
  ) {
    return this.runInTransaction(async (tx) => {
      const location = await tx.storageLocation.findUnique({
        where: { id: locationId },
        select: {
          code: true,
          type: true,
          warehouseId: true,
          _count: { select: { children: true } },
        },
      });
      if (!location) throw new NotFoundException('Location not found');
      if (
        location._count.children > 0 ||
        (NON_STOCK_LOCATION_TYPES as readonly string[]).includes(location.type)
      ) {
        throw new BadRequestException(
          `${location.code} doesn't hold stock directly. Count one of its bins.`,
        );
      }

      const ids = dto.lines.map((l) => l.inventoryLevelId);
      const [levels, stocks] = await Promise.all([
        tx.inventoryLevel.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            variantId: true,
            warehouseId: true,
            unitCost: true,
          },
        }),
        tx.locationStock.findMany({
          where: { locationId, inventoryLevelId: { in: ids } },
          select: { inventoryLevelId: true, quantity: true },
        }),
      ]);
      const levelById = new Map(levels.map((l) => [l.id, l]));
      const held = new Map(stocks.map((s) => [s.inventoryLevelId, s.quantity]));

      const items: Prisma.StockAdjustmentItemCreateWithoutAdjustmentInput[] =
        [];
      for (const line of dto.lines) {
        const level = levelById.get(line.inventoryLevelId);
        if (!level) {
          throw new NotFoundException(
            `Inventory level "${line.inventoryLevelId}" not found`,
          );
        }
        if (level.warehouseId !== location.warehouseId) {
          throw new BadRequestException(
            `Inventory level "${level.id}" is in a different warehouse from ${location.code}`,
          );
        }
        const expected = held.get(level.id) ?? 0;
        if (line.countedQty === expected) continue;
        items.push({
          variant: { connect: { id: level.variantId } },
          warehouse: { connect: { id: level.warehouseId } },
          location: { connect: { id: locationId } },
          expectedQty: expected,
          actualQty: line.countedQty,
          adjustmentQty: line.countedQty - expected,
          unitCost: level.unitCost,
        });
      }
      if (!items.length) return { adjustment: null };

      const adjustment = await tx.stockAdjustment.create({
        data: {
          adjustmentNumber: await this.nextAdjustmentNumber(tx),
          type: 'CYCLE_COUNT',
          reason: 'CYCLE_COUNT',
          status: 'PENDING',
          createdByUserId: actedBy ?? null,
          note: `Count of ${location.code}`,
          items: { create: items },
        },
        select: { id: true, adjustmentNumber: true, status: true },
      });

      if (dto.applyNow && (await this.canApproveAdjustments(tx, actedBy))) {
        return {
          adjustment: await this.applyAdjustment(tx, adjustment.id, actedBy),
        };
      }
      return { adjustment };
    });
  }

  async move(dto: MoveStockDto, actedBy?: string) {
    const movement = await this.runInTransaction((tx) =>
      this.moveStock(tx, { ...dto, userId: actedBy }),
    );
    return { message: 'Stock moved', data: movement };
  }

  async updateDefaultLocation(variantId: string, dto: SetDefaultLocationDto) {
    const level = await this.runInTransaction((tx) =>
      this.setDefaultLocation(tx, variantId, dto.locationId, dto.warehouseId),
    );
    return {
      message: dto.locationId ? 'Default rack set' : 'Default rack cleared',
      data: level,
    };
  }

  async updateThreshold(variantId: string, dto: UpdateThresholdDto) {
    try {
      const variant = await this.prisma.productVariant.update({
        where: { id: variantId },
        data: { lowStockThreshold: dto.lowStockThreshold },
        select: VARIANT_STOCK_SELECT,
      });
      return {
        message: 'Low-stock threshold updated',
        data: this.toStockView(variant),
      };
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Variant not found');
      }
      throw e;
    }
  }

  // ═════════════════════════════════════════════════
  //   READS
  // ═════════════════════════════════════════════════

  async findAll(query: InventoryQueryDto) {
    const {
      page,
      limit,
      search,
      productId,
      warehouseId,
      stockStatus,
      sortBy,
      sortOrder,
    } = query;

    const where: ProductVariantWhereInput = {
      product: { deletedAt: null, ...(productId && { id: productId }) },
      ...(warehouseId && { inventoryLevels: { some: { warehouseId } } }),
      ...(stockStatus && this.stockStatusWhere(stockStatus)),
    };
    if (search) {
      where.OR = [
        { sku: { contains: search, mode: 'insensitive' } },
        { product: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [total, variants] = await Promise.all([
      this.prisma.productVariant.count({ where }),
      this.prisma.productVariant.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ [sortBy]: sortOrder }, { id: 'asc' }],
        select: VARIANT_STOCK_SELECT,
      }),
    ]);

    return {
      data: variants.map((v) => this.toStockView(v)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async summary() {
    const live: ProductVariantWhereInput = { product: { deletedAt: null } };
    const liveLevels = {
      variant: { product: { deletedAt: null } },
      warehouse: {
        isActive: true,
        type: { in: [...SELLABLE_WAREHOUSE_TYPES] },
      },
    } satisfies Prisma.InventoryLevelWhereInput;

    const [totalVariants, outOfStock, lowStock, units, activeReservations] =
      await Promise.all([
        this.prisma.productVariant.count({ where: live }),
        this.prisma.productVariant.count({
          where: { ...live, ...this.stockStatusWhere('OUT_OF_STOCK') },
        }),
        this.prisma.productVariant.count({
          where: { ...live, ...this.stockStatusWhere('LOW_STOCK') },
        }),
        this.prisma.inventoryLevel.aggregate({
          where: liveLevels,
          _sum: {
            onHand: true,
            reserved: true,
            available: true,
            incoming: true,
            damaged: true,
            totalCost: true,
          },
        }),
        this.prisma.stockReservation.count({ where: { status: 'ACTIVE' } }),
      ]);

    return {
      data: {
        totalVariants,
        inStock: totalVariants - outOfStock - lowStock,
        lowStock,
        outOfStock,
        units: {
          onHand: units._sum.onHand ?? 0,
          reserved: units._sum.reserved ?? 0,
          available: units._sum.available ?? 0,
          incoming: units._sum.incoming ?? 0,
          damaged: units._sum.damaged ?? 0,
        },
        stockValue: units._sum.totalCost ?? new Decimal(0),
        activeReservations,
      },
    };
  }

  async findOne(variantId: string) {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      select: VARIANT_STOCK_SELECT,
    });
    if (!variant) throw new NotFoundException('Variant not found');

    const [recentMovements, activeReservations] = await Promise.all([
      this.prisma.inventoryMovement.findMany({
        where: { inventoryLevel: { variantId } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        include: {
          inventoryLevel: { select: { warehouse: { select: { code: true } } } },
          fromLocation: { select: { code: true } },
          toLocation: { select: { code: true } },
        },
      }),
      this.prisma.stockReservation.findMany({
        where: { variantId, status: 'ACTIVE' },
        orderBy: { reservedAt: 'desc' },
        include: { order: { select: { orderNumber: true } } },
      }),
    ]);

    return {
      data: {
        ...this.toStockView(variant),
        recentMovements,
        activeReservations,
      },
    };
  }

  async findMovements(query: MovementQueryDto) {
    const {
      page,
      limit,
      variantId,
      warehouseId,
      locationId,
      referenceType,
      referenceId,
      type,
      direction,
      dateFrom,
      dateTo,
    } = query;

    const where: InventoryMovementWhereInput = {
      ...((variantId || warehouseId) && {
        inventoryLevel: {
          ...(variantId && { variantId }),
          ...(warehouseId && { warehouseId }),
        },
      }),
      // A rack shows up as the source or destination of a movement.
      ...(locationId && {
        OR: [{ fromLocationId: locationId }, { toLocationId: locationId }],
      }),
      ...(referenceType && { referenceType }),
      ...(referenceId && { referenceId }),
      ...(type && { type }),
      ...(direction && { direction }),
      createdAt: dateRangeFilter(dateFrom, dateTo),
    };

    const [total, movements] = await Promise.all([
      this.prisma.inventoryMovement.count({ where }),
      this.prisma.inventoryMovement.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          inventoryLevel: {
            select: {
              warehouse: { select: { id: true, code: true, name: true } },
              variant: {
                select: {
                  id: true,
                  sku: true,
                  product: { select: { id: true, name: true } },
                },
              },
            },
          },
          fromLocation: { select: { id: true, code: true } },
          toLocation: { select: { id: true, code: true } },
          performedByUser: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
    ]);

    return {
      data: movements,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  // ═════════════════════════════════════════════════
  //   HELPERS
  // ═════════════════════════════════════════════════

  /** Gets (creating if missing) and row-locks the level for this transaction. */
  private async lockLevel(
    tx: Prisma.TransactionClient,
    variantId: string,
    warehouseId: string,
  ): Promise<LevelRow> {
    try {
      const { id } = await this.ensureLevel(tx, variantId, warehouseId);
      return await this.lockLevelById(tx, id);
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new NotFoundException('Variant or warehouse not found');
      }
      throw e;
    }
  }

  private async lockLevelById(
    tx: Prisma.TransactionClient,
    levelId: string,
  ): Promise<LevelRow> {
    const rows = await tx.$queryRaw<LevelRow[]>`
      SELECT "id", "warehouseId", "onHand", "reserved", "unitCost", "defaultLocationId"
      FROM "inventory_levels" WHERE "id" = ${levelId} FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Inventory level not found');
    return rows[0];
  }

  // ─── Rack helpers ───────────────────────────────
  // All of these run while the caller holds the InventoryLevel row lock,
  // which serializes every change to that level's LocationStock rows.

  /** Where inbound stock goes: explicit rack → default rack → UNASSIGNED. */
  private async resolvePutaway(
    tx: Prisma.TransactionClient,
    level: LevelRow,
    locationId?: string | null,
  ): Promise<string> {
    if (locationId) {
      await this.assertLocationInWarehouse(tx, locationId, level.warehouseId);
      return locationId;
    }
    if (level.defaultLocationId) {
      const def = await tx.storageLocation.findUnique({
        where: { id: level.defaultLocationId },
        select: { isActive: true },
      });
      if (def?.isActive) return level.defaultLocationId;
    }
    return this.getUnassignedLocationId(tx, level.warehouseId);
  }

  /**
   * Which racks outbound units come from. With `fromLocationId` it's that
   * rack only; otherwise: default rack first, then pickable racks, then the
   * smaller pile first (so overflow racks empty out), then walk order.
   */
  private async planPick(
    tx: Prisma.TransactionClient,
    level: LevelRow,
    quantity: number,
    fromLocationId?: string | null,
  ): Promise<Leg[]> {
    const rows = await tx.locationStock.findMany({
      where: {
        inventoryLevelId: level.id,
        quantity: { gt: 0 },
        ...(fromLocationId && { locationId: fromLocationId }),
      },
      select: {
        locationId: true,
        quantity: true,
        location: {
          select: { code: true, isPickable: true, pickSequence: true },
        },
      },
    });

    if (fromLocationId) {
      const have = rows[0]?.quantity ?? 0;
      if (have < quantity) {
        const loc = await tx.storageLocation.findUnique({
          where: { id: fromLocationId },
          select: { code: true },
        });
        throw new BadRequestException(
          `Rack "${loc?.code ?? fromLocationId}" holds ${have} unit(s) of this variant, ${quantity} requested`,
        );
      }
      return [{ locationId: fromLocationId, quantity }];
    }

    // Same plan the pick-route map shows (floor-plan/pick-plan.ts).
    const { legs, shortfall } = planPickLegs(
      level,
      quantity,
      rows.map((r) => ({
        locationId: r.locationId,
        quantity: r.quantity,
        ...r.location,
      })),
    );
    if (shortfall > 0) {
      // Racks must always add up to onHand — this means a bug or a manual
      // DB edit, not a user error.
      throw new InternalServerErrorException(
        `Rack quantities for inventory level ${level.id} don't cover onHand (${shortfall} unit(s) short)`,
      );
    }
    return legs;
  }

  /** Adds (+) or removes (-) units on one rack for this level. */
  private async changeLocationStock(
    tx: Prisma.TransactionClient,
    level: LevelRow,
    locationId: string,
    delta: number,
  ) {
    if (delta > 0) {
      await tx.locationStock.upsert({
        where: {
          inventoryLevelId_locationId: {
            inventoryLevelId: level.id,
            locationId,
          },
        },
        create: {
          inventoryLevelId: level.id,
          locationId,
          warehouseId: level.warehouseId,
          quantity: delta,
        },
        update: { quantity: { increment: delta } },
      });
      return;
    }

    const result = await tx.locationStock.updateMany({
      where: {
        inventoryLevelId: level.id,
        locationId,
        quantity: { gte: -delta },
      },
      data: { quantity: { increment: delta } },
    });
    if (result.count !== 1) {
      const loc = await tx.storageLocation.findUnique({
        where: { id: locationId },
        select: { code: true },
      });
      throw new BadRequestException(
        `Rack "${loc?.code ?? locationId}" doesn't hold ${-delta} unit(s) of this variant`,
      );
    }
  }

  /** The warehouse's catch-all location, created on first use. */
  async getUnassignedLocationId(
    tx: Prisma.TransactionClient,
    warehouseId: string,
  ): Promise<string> {
    const loc = await tx.storageLocation.upsert({
      where: {
        warehouseId_code: { warehouseId, code: UNASSIGNED_LOCATION_CODE },
      },
      create: {
        warehouseId,
        code: UNASSIGNED_LOCATION_CODE,
        name: 'Unassigned',
        type: 'STAGING',
        pickSequence: 999999,
        note: 'Stock whose rack is not known yet — move it onto real racks.',
      },
      update: {},
      select: { id: true },
    });
    return loc.id;
  }

  private async assertLocationInWarehouse(
    tx: Prisma.TransactionClient,
    locationId: string,
    warehouseId: string,
    opts: { allowInactive?: boolean } = {},
  ) {
    const loc = await tx.storageLocation.findUnique({
      where: { id: locationId },
      select: { warehouseId: true, isActive: true, code: true },
    });
    if (!loc) throw new NotFoundException(`Location "${locationId}" not found`);
    if (loc.warehouseId !== warehouseId) {
      throw new BadRequestException(
        `Location "${loc.code}" belongs to a different warehouse`,
      );
    }
    if (!loc.isActive && !opts.allowInactive) {
      throw new BadRequestException(`Location "${loc.code}" is inactive`);
    }
  }

  private async assertActiveSupplier(
    tx: Prisma.TransactionClient,
    supplierId: string,
  ) {
    const supplier = await tx.supplier.findUnique({
      where: { id: supplierId },
      select: { isActive: true, name: true },
    });
    if (!supplier) {
      throw new BadRequestException(`Supplier "${supplierId}" not found`);
    }
    if (!supplier.isActive) {
      throw new BadRequestException(`Supplier "${supplier.name}" is inactive`);
    }
  }

  private async skuOf(tx: Prisma.TransactionClient, variantId: string) {
    const variant = await tx.productVariant.findUnique({
      where: { id: variantId },
      select: { sku: true },
    });
    return variant?.sku ?? variantId;
  }

  /** Puts back stock that pre-reservation checkouts deducted with a SALE. */
  private async restockLegacySales(
    tx: Prisma.TransactionClient,
    orderId: string,
    opts: { note?: string | null; userId?: string | null },
  ) {
    const sales = await tx.inventoryMovement.findMany({
      where: { referenceType: 'ORDER', referenceId: orderId, type: 'SALE' },
      select: {
        quantity: true,
        unitCost: true,
        inventoryLevel: { select: { variantId: true, warehouseId: true } },
      },
    });
    for (const sale of sales) {
      await this.applyMovement(tx, {
        variantId: sale.inventoryLevel.variantId,
        warehouseId: sale.inventoryLevel.warehouseId,
        type: 'RETURN_RESTOCKED',
        quantity: sale.quantity,
        unitCost: sale.unitCost,
        referenceType: 'ORDER',
        referenceId: orderId,
        note: opts.note,
        userId: opts.userId,
      });
    }
  }

  private toStockChange(
    dto: AdjustStockItemDto,
    actedBy?: string,
  ): StockChange {
    return {
      variantId: dto.variantId,
      warehouseId: dto.warehouseId,
      locationId: dto.locationId,
      type: dto.type,
      quantity: dto.quantity,
      unitCost: dto.unitCost,
      referenceType: dto.orderId ? 'ORDER' : 'ADJUSTMENT',
      referenceId: dto.orderId,
      note: dto.note,
      userId: actedBy,
    };
  }

  // Compares two columns of the same row (stock vs lowStockThreshold).
  private stockStatusWhere(status: StockStatus): ProductVariantWhereInput {
    const threshold = this.prisma.productVariant.fields.lowStockThreshold;
    switch (status) {
      case 'OUT_OF_STOCK':
        return { stock: { lte: 0 } };
      case 'LOW_STOCK':
        return { stock: { gt: 0, lte: threshold } };
      case 'IN_STOCK':
        return { stock: { gt: threshold } };
    }
  }

  private toStockView(v: VariantStockRow) {
    // Sort by option name so the label is stable ("Color / Size").
    const name = [...v.optionValues]
      .sort((a, b) =>
        a.optionValue.option.name.localeCompare(b.optionValue.option.name),
      )
      .map((ov) => ov.optionValue.value)
      .join(' / ');

    const totals = v.inventoryLevels.reduce(
      (acc, l) => ({
        onHand: acc.onHand + l.onHand,
        reserved: acc.reserved + l.reserved,
        incoming: acc.incoming + l.incoming,
        damaged: acc.damaged + l.damaged,
      }),
      { onHand: 0, reserved: 0, incoming: 0, damaged: 0 },
    );

    return {
      variantId: v.id,
      sku: v.sku,
      name: name || v.sku,
      product: v.product,
      stock: v.stock, // sellable (available across sellable warehouses)
      ...totals,
      lowStockThreshold: v.lowStockThreshold,
      stockStatus: stockStatusOf(v),
      isActive: v.isActive,
      levels: v.inventoryLevels,
      updatedAt: v.updatedAt,
    };
  }

  private async runInTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (e) {
      // FK failure: orderId / actedBy / warehouse points at a missing row.
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new BadRequestException('Referenced record not found');
      }
      throw e;
    }
  }
}
