/*
  Warnings:

  - A unique constraint covering the columns `[campaignId,slug]` on the table `campaign_sections` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[promotionId,categoryId]` on the table `promotion_targets` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[promotionId,brandId]` on the table `promotion_targets` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[promotionId,tagId]` on the table `promotion_targets` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `targetType` to the `promotion_targets` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "RuleMatchType" AS ENUM ('ANY', 'ALL');

-- CreateEnum
CREATE TYPE "PromotionTargetType" AS ENUM ('PRODUCT', 'VARIANT', 'CATEGORY', 'BRAND', 'TAG', 'ALL_PRODUCTS');

-- AlterTable
ALTER TABLE "campaign_section_rules" ADD COLUMN     "matchType" "RuleMatchType" NOT NULL DEFAULT 'ANY';

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "archivedAt" TIMESTAMPTZ,
ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "promotion_targets" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "tagId" TEXT,
ADD COLUMN     "targetType" "PromotionTargetType" NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "campaign_sections_campaignId_slug_key" ON "campaign_sections"("campaignId", "slug");

-- CreateIndex
CREATE INDEX "promotion_targets_promotionId_targetType_idx" ON "promotion_targets"("promotionId", "targetType");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_targets_promotionId_categoryId_key" ON "promotion_targets"("promotionId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_targets_promotionId_brandId_key" ON "promotion_targets"("promotionId", "brandId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_targets_promotionId_tagId_key" ON "promotion_targets"("promotionId", "tagId");

-- AddForeignKey
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
