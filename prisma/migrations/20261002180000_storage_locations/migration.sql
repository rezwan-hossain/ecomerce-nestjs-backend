-- ═══════════════════════════════════════════════════
--  Storage locations (racks / shelves / bins) inside a warehouse.
--    * storage_locations: the racks, optional parent hierarchy
--    * location_stocks:   variant × rack quantity; per level they sum to onHand
--    * inventory_levels.defaultLocationId: the variant's usual rack
--    * movements record fromLocationId / toLocationId; LOCATION_MOVE moves
--      stock between racks without changing onHand
--  Existing stock is placed on a new UNASSIGNED location in each warehouse,
--  to be moved onto real racks later.
-- ═══════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('ZONE', 'AISLE', 'RACK', 'SHELF', 'BIN', 'RECEIVING', 'STAGING', 'PACKING');

-- AlterEnum
ALTER TYPE "MovementType" ADD VALUE 'LOCATION_MOVE';

-- DropIndex
DROP INDEX "stock_adjustment_items_adjustmentId_variantId_warehouseId_key";

-- AlterTable
ALTER TABLE "inventory_levels" ADD COLUMN     "defaultLocationId" TEXT;

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "fromLocationId" TEXT,
ADD COLUMN     "toLocationId" TEXT;

-- AlterTable
ALTER TABLE "stock_adjustment_items" ADD COLUMN     "locationId" TEXT;

-- CreateTable
CREATE TABLE "storage_locations" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "type" "LocationType" NOT NULL DEFAULT 'RACK',
    "parentId" TEXT,
    "isPickable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "pickSequence" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_stocks" (
    "id" TEXT NOT NULL,
    "inventoryLevelId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "storage_locations_parentId_idx" ON "storage_locations"("parentId");

-- CreateIndex
CREATE INDEX "storage_locations_warehouseId_isActive_idx" ON "storage_locations"("warehouseId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "storage_locations_warehouseId_code_key" ON "storage_locations"("warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "storage_locations_id_warehouseId_key" ON "storage_locations"("id", "warehouseId");

-- CreateIndex
CREATE INDEX "location_stocks_locationId_idx" ON "location_stocks"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "location_stocks_inventoryLevelId_locationId_key" ON "location_stocks"("inventoryLevelId", "locationId");

-- CreateIndex
CREATE INDEX "inventory_levels_defaultLocationId_idx" ON "inventory_levels"("defaultLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_levels_id_warehouseId_key" ON "inventory_levels"("id", "warehouseId");

-- CreateIndex
CREATE INDEX "inventory_movements_fromLocationId_idx" ON "inventory_movements"("fromLocationId");

-- CreateIndex
CREATE INDEX "inventory_movements_toLocationId_idx" ON "inventory_movements"("toLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustment_items_adjustmentId_variantId_warehouseId_l_key" ON "stock_adjustment_items"("adjustmentId", "variantId", "warehouseId", "locationId");

-- AddForeignKey
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_defaultLocationId_fkey" FOREIGN KEY ("defaultLocationId") REFERENCES "storage_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_stocks" ADD CONSTRAINT "location_stocks_inventoryLevelId_warehouseId_fkey" FOREIGN KEY ("inventoryLevelId", "warehouseId") REFERENCES "inventory_levels"("id", "warehouseId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_stocks" ADD CONSTRAINT "location_stocks_locationId_warehouseId_fkey" FOREIGN KEY ("locationId", "warehouseId") REFERENCES "storage_locations"("id", "warehouseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_items" ADD CONSTRAINT "stock_adjustment_items_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ═══════════════════════════════════════════════════
--  DATA MIGRATION
-- ═══════════════════════════════════════════════════

INSERT INTO "storage_locations" ("id", "warehouseId", "code", "name", "type", "isPickable", "pickSequence", "note", "updatedAt")
SELECT gen_random_uuid(), w."id", 'UNASSIGNED', 'Unassigned', 'STAGING', true, 999999,
       'Stock whose rack is not known yet — move it onto real racks.', NOW()
FROM "warehouses" w;

INSERT INTO "location_stocks" ("id", "inventoryLevelId", "locationId", "warehouseId", "quantity", "updatedAt")
SELECT gen_random_uuid(), il."id", sl."id", il."warehouseId", il."onHand", NOW()
FROM "inventory_levels" il
JOIN "storage_locations" sl ON sl."warehouseId" = il."warehouseId" AND sl."code" = 'UNASSIGNED'
WHERE il."onHand" > 0;

-- ═══════════════════════════════════════════════════
--  INTEGRITY GUARDS
-- ═══════════════════════════════════════════════════

ALTER TABLE "location_stocks"
  ADD CONSTRAINT "location_stocks_quantity_non_negative" CHECK ("quantity" >= 0);

ALTER TABLE "storage_locations"
  ADD CONSTRAINT "storage_locations_not_own_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id"),
  ADD CONSTRAINT "storage_locations_code_not_blank" CHECK (length(trim("code")) > 0);

-- A rack move needs both ends and they must differ. (Compared as text: a
-- value added to an enum can't be used as an enum literal in the same
-- transaction.)
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_location_move_valid" CHECK (
    "type"::text <> 'LOCATION_MOVE' OR
    ("fromLocationId" IS NOT NULL AND "toLocationId" IS NOT NULL AND "fromLocationId" <> "toLocationId")
  );
