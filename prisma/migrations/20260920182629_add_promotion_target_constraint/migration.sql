/*
  Warnings:

  - A unique constraint covering the columns `[promotionId,productId]` on the table `promotion_targets` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[promotionId,variantId]` on the table `promotion_targets` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "promotions" ADD COLUMN     "buyQuantity" INTEGER,
ADD COLUMN     "getQuantity" INTEGER,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "promotion_targets_promotionId_productId_key" ON "promotion_targets"("promotionId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_targets_promotionId_variantId_key" ON "promotion_targets"("promotionId", "variantId");
