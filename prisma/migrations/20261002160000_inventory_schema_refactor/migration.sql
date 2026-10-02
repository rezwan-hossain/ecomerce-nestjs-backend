-- Inventory schema refactor:
--   * RESERVATION_COMMITTED removed (shipping is recorded as a SALE movement)
--   * batches are per warehouse (warehouseId, unique per variant+warehouse+batchNumber)
--   * transfer items carry unitCost for destination valuation
--   * one PO line per variant per receiving warehouse
--   * at most one ACTIVE alert per variant/warehouse/type
--   * indexes that were a leading prefix of a unique/composite index dropped

-- AlterEnum
BEGIN;
CREATE TYPE "MovementType_new" AS ENUM ('PURCHASE_RECEIVED', 'RETURN_RESTOCKED', 'ADJUSTMENT_INCREASE', 'TRANSFER_IN', 'INITIAL_STOCK', 'SALE', 'ADJUSTMENT_DECREASE', 'TRANSFER_OUT', 'DAMAGED', 'LOST', 'EXPIRED', 'SAMPLE', 'WRITE_OFF', 'RESERVATION_CREATED', 'RESERVATION_RELEASED', 'RESERVATION_EXPIRED');
ALTER TABLE "inventory_movements" ALTER COLUMN "type" TYPE "MovementType_new" USING ("type"::text::"MovementType_new");
ALTER TYPE "MovementType" RENAME TO "MovementType_old";
ALTER TYPE "MovementType_new" RENAME TO "MovementType";
DROP TYPE "public"."MovementType_old";
COMMIT;

-- DropIndex
DROP INDEX "inventory_batches_variantId_batchNumber_key";

-- DropIndex
DROP INDEX "inventory_batches_variantId_idx";

-- DropIndex
DROP INDEX "inventory_levels_available_idx";

-- DropIndex
DROP INDEX "inventory_levels_variantId_idx";

-- DropIndex
DROP INDEX "inventory_transfer_items_transferId_idx";

-- DropIndex
DROP INDEX "purchase_order_items_purchaseOrderId_idx";

-- DropIndex
DROP INDEX "reorder_rules_variantId_idx";

-- DropIndex
DROP INDEX "stock_adjustment_items_adjustmentId_idx";

-- DropIndex
DROP INDEX "stock_reservations_status_idx";

-- AlterTable
ALTER TABLE "inventory_batches" ADD COLUMN     "warehouseId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "inventory_transfer_items" ADD COLUMN     "unitCost" DECIMAL(12,4);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_alerts_one_active_key" ON "inventory_alerts"("variantId", "warehouseId", "type") WHERE ("status" = 'ACTIVE');

-- CreateIndex
CREATE INDEX "inventory_batches_warehouseId_idx" ON "inventory_batches"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_batches_variantId_warehouseId_batchNumber_key" ON "inventory_batches"("variantId", "warehouseId", "batchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_items_purchaseOrderId_variantId_warehouseId_key" ON "purchase_order_items"("purchaseOrderId", "variantId", "warehouseId");

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "inventory_transfer_items"
  ADD CONSTRAINT "inventory_transfer_items_unit_cost_non_negative" CHECK ("unitCost" IS NULL OR "unitCost" >= 0);
