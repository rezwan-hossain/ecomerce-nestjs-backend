-- ═══════════════════════════════════════════════════
--  Rack map: warehouse floor size, floor-plan placement and rotation of
--  floor-level locations, and level / slot numbers for shelves and bins.
--  Layout only — no stock or ledger data changes. Existing shelves and bins
--  are numbered by scripts/backfill-location-levels.ts, not here.
-- ═══════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "storage_locations" ADD COLUMN     "levelNumber" INTEGER,
ADD COLUMN     "mapCenterX" DECIMAL(8,2),
ADD COLUMN     "mapCenterY" DECIMAL(8,2),
ADD COLUMN     "mapDepth" DECIMAL(8,2),
ADD COLUMN     "mapLength" DECIMAL(8,2),
ADD COLUMN     "mapRotation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "slotIndex" INTEGER;

-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "floorDepth" DECIMAL(8,2),
ADD COLUMN     "floorWidth" DECIMAL(8,2);

-- CreateIndex
CREATE UNIQUE INDEX "storage_locations_parentId_levelNumber_key" ON "storage_locations"("parentId", "levelNumber");

-- CreateIndex
CREATE UNIQUE INDEX "storage_locations_parentId_slotIndex_key" ON "storage_locations"("parentId", "slotIndex");


-- ═══════════════════════════════════════════════════
--  INTEGRITY GUARDS
-- ═══════════════════════════════════════════════════

ALTER TABLE "storage_locations"
  ADD CONSTRAINT "storage_locations_map_rotation_check"
    CHECK ("mapRotation" IN (0, 90, 180, 270)),
  ADD CONSTRAINT "storage_locations_map_all_or_none"
    CHECK (
      ("mapCenterX" IS NULL AND "mapCenterY" IS NULL AND "mapLength" IS NULL AND "mapDepth" IS NULL)
      OR
      ("mapCenterX" IS NOT NULL AND "mapCenterY" IS NOT NULL AND "mapLength" > 0 AND "mapDepth" > 0)
    ),
  ADD CONSTRAINT "storage_locations_level_number_check" CHECK ("levelNumber" IS NULL OR "levelNumber" >= 1),
  ADD CONSTRAINT "storage_locations_slot_index_check" CHECK ("slotIndex" IS NULL OR "slotIndex" >= 0);

ALTER TABLE "warehouses"
  ADD CONSTRAINT "warehouses_floor_size_check"
    CHECK (("floorWidth" IS NULL AND "floorDepth" IS NULL) OR ("floorWidth" > 0 AND "floorDepth" > 0));
