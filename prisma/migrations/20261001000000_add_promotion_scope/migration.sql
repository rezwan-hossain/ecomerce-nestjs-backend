-- CreateEnum
CREATE TYPE "PromotionScope" AS ENUM ('ALL', 'SPECIFIC');

-- AlterTable
ALTER TABLE "promotions" ADD COLUMN     "scope" "PromotionScope" NOT NULL DEFAULT 'SPECIFIC';

-- Backfill: promotions that had an ALL_PRODUCTS target applied to everything.
UPDATE "promotions" p SET "scope" = 'ALL'
WHERE EXISTS (
  SELECT 1 FROM "promotion_targets" t
  WHERE t."promotionId" = p."id" AND t."targetType" = 'ALL_PRODUCTS'
);

-- Backfill: shipping promotions with no targets used to apply to the whole cart.
UPDATE "promotions" p SET "scope" = 'ALL'
WHERE p."type" IN ('FREE_SHIPPING', 'SHIPPING_DISCOUNT')
  AND NOT EXISTS (SELECT 1 FROM "promotion_targets" t WHERE t."promotionId" = p."id");

-- ALL-scope promotions carry no targets. Any specific targets alongside an
-- ALL_PRODUCTS target were redundant (ALL_PRODUCTS already matched everything).
DELETE FROM "promotion_targets" t
USING "promotions" p
WHERE t."promotionId" = p."id" AND p."scope" = 'ALL';

-- AlterEnum
BEGIN;
CREATE TYPE "PromotionTargetType_new" AS ENUM ('PRODUCT', 'VARIANT', 'CATEGORY', 'BRAND', 'TAG');
ALTER TABLE "promotion_targets" ALTER COLUMN "targetType" TYPE "PromotionTargetType_new" USING ("targetType"::text::"PromotionTargetType_new");
ALTER TYPE "PromotionTargetType" RENAME TO "PromotionTargetType_old";
ALTER TYPE "PromotionTargetType_new" RENAME TO "PromotionTargetType";
DROP TYPE "public"."PromotionTargetType_old";
COMMIT;
