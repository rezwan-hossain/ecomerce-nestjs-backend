import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ==========================================
   INVENTORY SCHEMAS & DTOS
   ----------------------------------------
   SALE, INITIAL_STOCK, TRANSFER_* and RESERVATION_* movements are written
   by the system (checkout/shipping, variant creation, transfers) and can't
   be posted manually.
   ========================================== */

export const manualMovementTypeEnum = z.enum([
  'PURCHASE_RECEIVED', //   + goods received outside a purchase order
  'RETURN_RESTOCKED', //    + customer return put back to sellable
  'ADJUSTMENT_INCREASE', // + correction
  'ADJUSTMENT_DECREASE', // - correction
  'DAMAGED', //             - moved to the damaged bucket
  'LOST', //                - shrinkage / theft
  'EXPIRED', //             - past expiry
  'SAMPLE', //              - given away as sample
  'WRITE_OFF', //           - other write-off
]);

export const movementTypeEnum = z.enum([
  'PURCHASE_RECEIVED',
  'RETURN_RESTOCKED',
  'ADJUSTMENT_INCREASE',
  'TRANSFER_IN',
  'INITIAL_STOCK',
  'SALE',
  'ADJUSTMENT_DECREASE',
  'TRANSFER_OUT',
  'DAMAGED',
  'LOST',
  'EXPIRED',
  'SAMPLE',
  'WRITE_OFF',
  'RESERVATION_CREATED',
  'RESERVATION_RELEASED',
  'RESERVATION_EXPIRED',
  'LOCATION_MOVE',
]);

export const referenceTypeEnum = z.enum([
  'ORDER',
  'ORDER_ITEM',
  'PURCHASE_ORDER',
  'PURCHASE_ORDER_ITEM',
  'TRANSFER',
  'ADJUSTMENT',
  'RETURN',
  'RESERVATION',
]);

const note = z.string().trim().max(500).optional();

export const adjustStockItemSchema = z.object({
  variantId: z.string().uuid(),
  warehouseId: z.string().uuid().optional(), // defaults to the default warehouse
  // Rack to put away to / take from. Omitted: inbound goes to the default
  // rack (else UNASSIGNED), outbound is auto-picked across racks.
  locationId: z.string().uuid().optional(),
  type: manualMovementTypeEnum,
  // Positive count of units; the type decides the direction.
  quantity: z.number().int().positive(),
  // Inbound only: unit cost feeding the weighted average cost.
  unitCost: z.number().nonnegative().optional(),
  orderId: z.string().uuid().optional(), // e.g. the order a return came from
  note,
});

export class AdjustStockItemDto extends createZodDto(adjustStockItemSchema) {}

// All-or-nothing: e.g. receiving a supplier delivery of many SKUs.
export const bulkAdjustStockSchema = z.object({
  items: z.array(adjustStockItemSchema).min(1).max(200),
});

export class BulkAdjustStockDto extends createZodDto(bulkAdjustStockSchema) {}

// Stock take: set the exact physically counted quantity.
export const stockCountSchema = z.object({
  warehouseId: z.string().uuid().optional(), // defaults to the default warehouse
  // Count one rack; omitted → count for the whole warehouse.
  locationId: z.string().uuid().optional(),
  countedQuantity: z.number().int().nonnegative(), // physically counted
  note,
});

export class StockCountDto extends createZodDto(stockCountSchema) {}

// Rack → rack inside one warehouse; doesn't change sellable stock.
export const moveStockSchema = z
  .object({
    variantId: z.string().uuid(),
    warehouseId: z.string().uuid().optional(), // defaults to the default warehouse
    fromLocationId: z.string().uuid(),
    toLocationId: z.string().uuid(),
    quantity: z.number().int().positive(),
    note,
  })
  .refine((d) => d.fromLocationId !== d.toLocationId, {
    message: 'fromLocationId and toLocationId must differ',
    path: ['toLocationId'],
  });

export class MoveStockDto extends createZodDto(moveStockSchema) {}

export const setDefaultLocationSchema = z.object({
  warehouseId: z.string().uuid().optional(), // defaults to the default warehouse
  locationId: z.string().uuid().nullable(), // null clears it
});

export class SetDefaultLocationDto extends createZodDto(
  setDefaultLocationSchema,
) {}

export const updateThresholdSchema = z.object({
  lowStockThreshold: z.number().int().nonnegative(),
});

export class UpdateThresholdDto extends createZodDto(updateThresholdSchema) {}

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export const stockStatusEnum = z.enum([
  'IN_STOCK',
  'LOW_STOCK',
  'OUT_OF_STOCK',
]);

export const inventoryQuerySchema = z.object({
  ...pagination,
  search: z.string().trim().min(1).optional(), // SKU or product name
  productId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(), // only variants stocked there
  stockStatus: stockStatusEnum.optional(),
  sortBy: z.enum(['stock', 'sku', 'updatedAt']).default('stock'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export class InventoryQueryDto extends createZodDto(inventoryQuerySchema) {}

// "2026-10-02" or "2026-10-02T14:30:00Z" / "...+06:00"
const isoDateOrDateTime = z.union([
  z.iso.date(),
  z.iso.datetime({ offset: true }),
]);

export const movementQuerySchema = z.object({
  ...pagination,
  variantId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(), // movements in or out of this rack
  referenceType: referenceTypeEnum.optional(),
  referenceId: z.string().optional(),
  type: movementTypeEnum.optional(),
  direction: z.enum(['IN', 'OUT', 'INTERNAL']).optional(),
  // ISO strings, not z.date(): Date can't be represented in JSON Schema,
  // which nestjs-zod generates from these DTOs. A date-only dateTo
  // ("2026-10-02") includes that whole day.
  dateFrom: isoDateOrDateTime.optional(),
  dateTo: isoDateOrDateTime.optional(),
});

export class MovementQueryDto extends createZodDto(movementQuerySchema) {}
