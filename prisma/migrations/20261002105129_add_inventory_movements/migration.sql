-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('INITIAL_STOCK', 'RESTOCK', 'SALE', 'ORDER_CANCELLED', 'RETURN', 'DAMAGED', 'LOST', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "lowStockThreshold" INTEGER NOT NULL DEFAULT 5;

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "stockBefore" INTEGER NOT NULL,
    "stockAfter" INTEGER NOT NULL,
    "orderId" TEXT,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_movements_variantId_createdAt_idx" ON "inventory_movements"("variantId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_movements_orderId_idx" ON "inventory_movements"("orderId");

-- CreateIndex
CREATE INDEX "inventory_movements_type_idx" ON "inventory_movements"("type");

-- CreateIndex
CREATE INDEX "inventory_movements_createdAt_idx" ON "inventory_movements"("createdAt");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Last line of defense against overselling: the DB refuses negative stock
-- even if application code has a bug.
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_stock_non_negative" CHECK ("stock" >= 0);
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_low_stock_threshold_non_negative" CHECK ("lowStockThreshold" >= 0);

-- A movement always changes stock, and its snapshot must be consistent.
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_quantity_non_zero" CHECK ("quantity" <> 0);
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_balance" CHECK ("stockAfter" = "stockBefore" + "quantity" AND "stockAfter" >= 0);

-- Backfill: open the ledger with the current stock of every existing variant,
-- so SUM(quantity) per variant always equals product_variants.stock.
INSERT INTO "inventory_movements" ("id", "variantId", "type", "quantity", "stockBefore", "stockAfter", "note", "createdAt")
SELECT gen_random_uuid(), "id", 'INITIAL_STOCK', "stock", 0, "stock", 'Opening balance (inventory ledger introduced)', NOW()
FROM "product_variants"
WHERE "stock" > 0;
