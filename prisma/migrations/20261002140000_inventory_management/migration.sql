-- ═══════════════════════════════════════════════════
--  Inventory management: warehouses, per-warehouse levels, reservations,
--  batches, suppliers, purchase orders, transfers, adjustments, reorder
--  rules and alerts. Replaces the single-location ledger from
--  20261002105129_add_inventory_movements WITHOUT losing data:
--    * a default "MAIN" warehouse is created
--    * every variant gets an inventory level there with onHand = stock
--    * existing ledger rows are converted to the new movement format
-- ═══════════════════════════════════════════════════

-- Park the old ledger so the new table can take its name.
ALTER TABLE "inventory_movements" RENAME TO "inventory_movements_legacy";
ALTER TABLE "inventory_movements_legacy" RENAME CONSTRAINT "inventory_movements_pkey" TO "inventory_movements_legacy_pkey";
DROP INDEX "inventory_movements_variantId_createdAt_idx";
DROP INDEX "inventory_movements_orderId_idx";
DROP INDEX "inventory_movements_type_idx";
DROP INDEX "inventory_movements_createdAt_idx";

-- CreateEnum
CREATE TYPE "WarehouseType" AS ENUM ('PHYSICAL', 'STORE', 'VIRTUAL_DAMAGE', 'VIRTUAL_QC', 'VIRTUAL_RETURN');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('PURCHASE_RECEIVED', 'RETURN_RESTOCKED', 'ADJUSTMENT_INCREASE', 'TRANSFER_IN', 'INITIAL_STOCK', 'SALE', 'ADJUSTMENT_DECREASE', 'TRANSFER_OUT', 'DAMAGED', 'LOST', 'EXPIRED', 'SAMPLE', 'WRITE_OFF', 'RESERVATION_CREATED', 'RESERVATION_RELEASED', 'RESERVATION_COMMITTED', 'RESERVATION_EXPIRED');

-- CreateEnum
CREATE TYPE "MovementDirection" AS ENUM ('IN', 'OUT', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ReferenceType" AS ENUM ('ORDER', 'ORDER_ITEM', 'PURCHASE_ORDER', 'PURCHASE_ORDER_ITEM', 'TRANSFER', 'ADJUSTMENT', 'RETURN', 'RESERVATION');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('AVAILABLE', 'DEPLETED', 'EXPIRED', 'QUARANTINED', 'RECALLED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'CONFIRMED', 'PARTIAL', 'RECEIVED', 'CANCELLED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PurchaseOrderItemStatus" AS ENUM ('PENDING', 'PARTIAL', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('DRAFT', 'PENDING', 'IN_TRANSIT', 'PARTIAL', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('INCREASE', 'DECREASE', 'CYCLE_COUNT');

-- CreateEnum
CREATE TYPE "AdjustmentReason" AS ENUM ('CYCLE_COUNT', 'DAMAGE', 'THEFT', 'LOSS', 'EXPIRY', 'CORRECTION', 'OPENING_STOCK', 'PROMOTIONAL', 'OTHER');

-- CreateEnum
CREATE TYPE "AdjustmentStatus" AS ENUM ('PENDING', 'APPROVED', 'APPLIED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InventoryAlertType" AS ENUM ('LOW_STOCK', 'OUT_OF_STOCK', 'OVERSTOCK', 'EXPIRING_SOON', 'NEGATIVE_STOCK', 'REORDER_TRIGGERED');

-- CreateEnum
CREATE TYPE "InventoryAlertStatus" AS ENUM ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "warehouses" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "WarehouseType" NOT NULL DEFAULT 'PHYSICAL',
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_levels" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL DEFAULT 0,
    "incoming" INTEGER NOT NULL DEFAULT 0,
    "damaged" INTEGER NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" TEXT NOT NULL,
    "inventoryLevelId" TEXT NOT NULL,
    "type" "MovementType" NOT NULL,
    "direction" "MovementDirection" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "onHandBefore" INTEGER NOT NULL,
    "onHandAfter" INTEGER NOT NULL,
    "reservedBefore" INTEGER,
    "reservedAfter" INTEGER,
    "unitCost" DECIMAL(12,4),
    "totalCost" DECIMAL(14,4),
    "referenceType" "ReferenceType",
    "referenceId" TEXT,
    "sourceWarehouseId" TEXT,
    "destWarehouseId" TEXT,
    "performedByUserId" TEXT,
    "batchId" TEXT,
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservations" (
    "id" TEXT NOT NULL,
    "inventoryLevelId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "orderId" TEXT,
    "orderItemId" TEXT,
    "quantity" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_batches" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "barcode" TEXT,
    "quantity" INTEGER NOT NULL,
    "initialQty" INTEGER NOT NULL,
    "unitCost" DECIMAL(12,4),
    "manufacturedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "supplierId" TEXT,
    "purchaseOrderItemId" TEXT,
    "status" "BatchStatus" NOT NULL DEFAULT 'AVAILABLE',
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "company" TEXT,
    "website" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "paymentTerms" TEXT,
    "leadTimeDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "subtotalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "shippingAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "orderedAt" TIMESTAMP(3),
    "expectedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "approvedByUserId" TEXT,
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "orderedQty" INTEGER NOT NULL,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,
    "damagedQty" INTEGER NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(12,4) NOT NULL,
    "totalCost" DECIMAL(14,4) NOT NULL,
    "status" "PurchaseOrderItemStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transfers" (
    "id" TEXT NOT NULL,
    "transferNumber" TEXT NOT NULL,
    "fromWarehouseId" TEXT NOT NULL,
    "toWarehouseId" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'DRAFT',
    "initiatedByUserId" TEXT,
    "receivedByUserId" TEXT,
    "shippedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transfer_items" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "sentQty" INTEGER NOT NULL,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,
    "damagedQty" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustments" (
    "id" TEXT NOT NULL,
    "adjustmentNumber" TEXT NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "reason" "AdjustmentReason" NOT NULL,
    "status" "AdjustmentStatus" NOT NULL DEFAULT 'PENDING',
    "createdByUserId" TEXT,
    "approvedByUserId" TEXT,
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "stock_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustment_items" (
    "id" TEXT NOT NULL,
    "adjustmentId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "expectedQty" INTEGER,
    "actualQty" INTEGER,
    "adjustmentQty" INTEGER NOT NULL,
    "unitCost" DECIMAL(12,4),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_adjustment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reorder_rules" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "reorderPoint" INTEGER NOT NULL,
    "reorderQty" INTEGER NOT NULL,
    "safetyStock" INTEGER NOT NULL DEFAULT 0,
    "maxStock" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "autoReorder" BOOLEAN NOT NULL DEFAULT false,
    "preferredSupplierId" TEXT,
    "lastTriggeredAt" TIMESTAMP(3),
    "lastOrderedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reorder_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_alerts" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "type" "InventoryAlertType" NOT NULL,
    "status" "InventoryAlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" TEXT NOT NULL,
    "message" TEXT,
    "currentStock" INTEGER NOT NULL,
    "threshold" INTEGER,
    "acknowledgedByUserId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_name_key" ON "warehouses"("name");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("code");

-- CreateIndex
CREATE INDEX "warehouses_isActive_idx" ON "warehouses"("isActive");

-- CreateIndex
CREATE INDEX "warehouses_type_idx" ON "warehouses"("type");

-- CreateIndex
CREATE INDEX "inventory_levels_warehouseId_idx" ON "inventory_levels"("warehouseId");

-- CreateIndex
CREATE INDEX "inventory_levels_variantId_idx" ON "inventory_levels"("variantId");

-- CreateIndex
CREATE INDEX "inventory_levels_available_idx" ON "inventory_levels"("available");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_levels_variantId_warehouseId_key" ON "inventory_levels"("variantId", "warehouseId");

-- CreateIndex
CREATE INDEX "stock_reservations_inventoryLevelId_idx" ON "stock_reservations"("inventoryLevelId");

-- CreateIndex
CREATE INDEX "stock_reservations_variantId_idx" ON "stock_reservations"("variantId");

-- CreateIndex
CREATE INDEX "stock_reservations_orderId_idx" ON "stock_reservations"("orderId");

-- CreateIndex
CREATE INDEX "stock_reservations_status_expiresAt_idx" ON "stock_reservations"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "stock_reservations_status_idx" ON "stock_reservations"("status");

-- CreateIndex
CREATE INDEX "inventory_batches_variantId_idx" ON "inventory_batches"("variantId");

-- CreateIndex
CREATE INDEX "inventory_batches_expiresAt_idx" ON "inventory_batches"("expiresAt");

-- CreateIndex
CREATE INDEX "inventory_batches_status_idx" ON "inventory_batches"("status");

-- CreateIndex
CREATE INDEX "inventory_batches_supplierId_idx" ON "inventory_batches"("supplierId");

-- CreateIndex
CREATE INDEX "inventory_batches_purchaseOrderItemId_idx" ON "inventory_batches"("purchaseOrderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_batches_variantId_batchNumber_key" ON "inventory_batches"("variantId", "batchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_code_key" ON "suppliers"("code");

-- CreateIndex
CREATE INDEX "suppliers_isActive_idx" ON "suppliers"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_poNumber_key" ON "purchase_orders"("poNumber");

-- CreateIndex
CREATE INDEX "purchase_orders_supplierId_idx" ON "purchase_orders"("supplierId");

-- CreateIndex
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders"("status");

-- CreateIndex
CREATE INDEX "purchase_orders_orderedAt_idx" ON "purchase_orders"("orderedAt");

-- CreateIndex
CREATE INDEX "purchase_order_items_purchaseOrderId_idx" ON "purchase_order_items"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "purchase_order_items_variantId_idx" ON "purchase_order_items"("variantId");

-- CreateIndex
CREATE INDEX "purchase_order_items_warehouseId_idx" ON "purchase_order_items"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transfers_transferNumber_key" ON "inventory_transfers"("transferNumber");

-- CreateIndex
CREATE INDEX "inventory_transfers_fromWarehouseId_idx" ON "inventory_transfers"("fromWarehouseId");

-- CreateIndex
CREATE INDEX "inventory_transfers_toWarehouseId_idx" ON "inventory_transfers"("toWarehouseId");

-- CreateIndex
CREATE INDEX "inventory_transfers_status_idx" ON "inventory_transfers"("status");

-- CreateIndex
CREATE INDEX "inventory_transfer_items_transferId_idx" ON "inventory_transfer_items"("transferId");

-- CreateIndex
CREATE INDEX "inventory_transfer_items_variantId_idx" ON "inventory_transfer_items"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transfer_items_transferId_variantId_key" ON "inventory_transfer_items"("transferId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustments_adjustmentNumber_key" ON "stock_adjustments"("adjustmentNumber");

-- CreateIndex
CREATE INDEX "stock_adjustments_type_idx" ON "stock_adjustments"("type");

-- CreateIndex
CREATE INDEX "stock_adjustments_status_idx" ON "stock_adjustments"("status");

-- CreateIndex
CREATE INDEX "stock_adjustments_createdAt_idx" ON "stock_adjustments"("createdAt");

-- CreateIndex
CREATE INDEX "stock_adjustment_items_adjustmentId_idx" ON "stock_adjustment_items"("adjustmentId");

-- CreateIndex
CREATE INDEX "stock_adjustment_items_variantId_idx" ON "stock_adjustment_items"("variantId");

-- CreateIndex
CREATE INDEX "stock_adjustment_items_warehouseId_idx" ON "stock_adjustment_items"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustment_items_adjustmentId_variantId_warehouseId_key" ON "stock_adjustment_items"("adjustmentId", "variantId", "warehouseId");

-- CreateIndex
CREATE INDEX "reorder_rules_isActive_idx" ON "reorder_rules"("isActive");

-- CreateIndex
CREATE INDEX "reorder_rules_variantId_idx" ON "reorder_rules"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "reorder_rules_variantId_warehouseId_key" ON "reorder_rules"("variantId", "warehouseId");

-- CreateIndex
CREATE INDEX "inventory_alerts_type_status_idx" ON "inventory_alerts"("type", "status");

-- CreateIndex
CREATE INDEX "inventory_alerts_variantId_idx" ON "inventory_alerts"("variantId");

-- CreateIndex
CREATE INDEX "inventory_alerts_warehouseId_idx" ON "inventory_alerts"("warehouseId");

-- CreateIndex
CREATE INDEX "inventory_alerts_status_idx" ON "inventory_alerts"("status");

-- CreateIndex
CREATE INDEX "inventory_alerts_createdAt_idx" ON "inventory_alerts"("createdAt");

-- CreateIndex
CREATE INDEX "inventory_movements_createdAt_idx" ON "inventory_movements"("createdAt");

-- CreateIndex
CREATE INDEX "inventory_movements_inventoryLevelId_createdAt_idx" ON "inventory_movements"("inventoryLevelId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_movements_type_idx" ON "inventory_movements"("type");

-- CreateIndex
CREATE INDEX "inventory_movements_referenceType_referenceId_idx" ON "inventory_movements"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "inventory_movements_batchId_idx" ON "inventory_movements"("batchId");

-- CreateIndex
CREATE INDEX "inventory_movements_performedByUserId_idx" ON "inventory_movements"("performedByUserId");

-- AddForeignKey
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_inventoryLevelId_fkey" FOREIGN KEY ("inventoryLevelId") REFERENCES "inventory_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_sourceWarehouseId_fkey" FOREIGN KEY ("sourceWarehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_destWarehouseId_fkey" FOREIGN KEY ("destWarehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "inventory_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_inventoryLevelId_fkey" FOREIGN KEY ("inventoryLevelId") REFERENCES "inventory_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_fromWarehouseId_fkey" FOREIGN KEY ("fromWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_toWarehouseId_fkey" FOREIGN KEY ("toWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_receivedByUserId_fkey" FOREIGN KEY ("receivedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfer_items" ADD CONSTRAINT "inventory_transfer_items_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "inventory_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfer_items" ADD CONSTRAINT "inventory_transfer_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_items" ADD CONSTRAINT "stock_adjustment_items_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "stock_adjustments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_items" ADD CONSTRAINT "stock_adjustment_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_items" ADD CONSTRAINT "stock_adjustment_items_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reorder_rules" ADD CONSTRAINT "reorder_rules_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reorder_rules" ADD CONSTRAINT "reorder_rules_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reorder_rules" ADD CONSTRAINT "reorder_rules_preferredSupplierId_fkey" FOREIGN KEY ("preferredSupplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_alerts" ADD CONSTRAINT "inventory_alerts_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_alerts" ADD CONSTRAINT "inventory_alerts_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_alerts" ADD CONSTRAINT "inventory_alerts_acknowledgedByUserId_fkey" FOREIGN KEY ("acknowledgedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════
--  DATA MIGRATION
-- ═══════════════════════════════════════════════════

INSERT INTO "warehouses" ("id", "name", "code", "type", "isActive", "isDefault", "priority", "updatedAt")
VALUES (gen_random_uuid(), 'Main Warehouse', 'MAIN', 'PHYSICAL', true, true, 100, NOW());

INSERT INTO "inventory_levels" ("id", "variantId", "warehouseId", "onHand", "reserved", "available", "updatedAt")
SELECT gen_random_uuid(), v."id", w."id", v."stock", 0, v."stock", NOW()
FROM "product_variants" v
CROSS JOIN "warehouses" w
WHERE w."code" = 'MAIN';

INSERT INTO "inventory_movements" (
  "id", "inventoryLevelId", "type", "direction", "quantity",
  "onHandBefore", "onHandAfter", "referenceType", "referenceId",
  "performedByUserId", "note", "metadata", "createdAt"
)
SELECT
  l."id",
  il."id",
  (CASE l."type"::text
    WHEN 'INITIAL_STOCK'   THEN 'INITIAL_STOCK'
    WHEN 'RESTOCK'         THEN 'PURCHASE_RECEIVED'
    WHEN 'SALE'            THEN 'SALE'
    WHEN 'ORDER_CANCELLED' THEN 'RETURN_RESTOCKED'
    WHEN 'RETURN'          THEN 'RETURN_RESTOCKED'
    WHEN 'DAMAGED'         THEN 'DAMAGED'
    WHEN 'LOST'            THEN 'LOST'
    WHEN 'ADJUSTMENT'      THEN CASE WHEN l."quantity" > 0 THEN 'ADJUSTMENT_INCREASE' ELSE 'ADJUSTMENT_DECREASE' END
  END)::"MovementType",
  (CASE WHEN l."quantity" > 0 THEN 'IN' ELSE 'OUT' END)::"MovementDirection",
  ABS(l."quantity"),
  l."stockBefore",
  l."stockAfter",
  CASE WHEN l."orderId" IS NOT NULL THEN 'ORDER'::"ReferenceType" END,
  l."orderId",
  l."createdByUserId",
  l."note",
  jsonb_build_object('legacyType', l."type"::text),
  l."createdAt"
FROM "inventory_movements_legacy" l
JOIN "warehouses" w ON w."code" = 'MAIN'
JOIN "inventory_levels" il ON il."variantId" = l."variantId" AND il."warehouseId" = w."id";

DROP TABLE "inventory_movements_legacy";
DROP TYPE "InventoryMovementType";

-- ═══════════════════════════════════════════════════
--  INTEGRITY GUARDS (last line of defense against app bugs)
-- ═══════════════════════════════════════════════════

-- At most one default warehouse.
CREATE UNIQUE INDEX "warehouses_single_default_key" ON "warehouses"("isDefault") WHERE ("isDefault" = true);

ALTER TABLE "inventory_levels"
  ADD CONSTRAINT "inventory_levels_quantities_non_negative"
    CHECK ("onHand" >= 0 AND "reserved" >= 0 AND "available" >= 0 AND "incoming" >= 0 AND "damaged" >= 0),
  ADD CONSTRAINT "inventory_levels_available_consistent"
    CHECK ("available" = "onHand" - "reserved");

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "inventory_movements_on_hand_non_negative" CHECK ("onHandBefore" >= 0 AND "onHandAfter" >= 0),
  ADD CONSTRAINT "inventory_movements_balance" CHECK (
    ("direction" = 'IN'       AND "onHandAfter" = "onHandBefore" + "quantity") OR
    ("direction" = 'OUT'      AND "onHandAfter" = "onHandBefore" - "quantity") OR
    ("direction" = 'INTERNAL' AND "onHandAfter" = "onHandBefore")
  );

ALTER TABLE "stock_reservations"
  ADD CONSTRAINT "stock_reservations_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "inventory_batches"
  ADD CONSTRAINT "inventory_batches_quantities_valid" CHECK ("quantity" >= 0 AND "initialQty" >= 0);

ALTER TABLE "purchase_order_items"
  ADD CONSTRAINT "purchase_order_items_quantities_valid"
    CHECK ("orderedQty" > 0 AND "receivedQty" >= 0 AND "damagedQty" >= 0 AND "receivedQty" + "damagedQty" <= "orderedQty");

ALTER TABLE "inventory_transfers"
  ADD CONSTRAINT "inventory_transfers_distinct_warehouses" CHECK ("fromWarehouseId" <> "toWarehouseId");

ALTER TABLE "inventory_transfer_items"
  ADD CONSTRAINT "inventory_transfer_items_quantities_valid"
    CHECK ("sentQty" > 0 AND "receivedQty" >= 0 AND "damagedQty" >= 0 AND "receivedQty" + "damagedQty" <= "sentQty");

ALTER TABLE "reorder_rules"
  ADD CONSTRAINT "reorder_rules_quantities_valid"
    CHECK ("reorderPoint" >= 0 AND "reorderQty" > 0 AND "safetyStock" >= 0 AND ("maxStock" IS NULL OR "maxStock" >= "reorderPoint"));
