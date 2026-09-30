-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "optionKey" TEXT;

-- Backfill optionKey for existing variants (sorted optionValueIds joined by ':').
-- Variants without option values stay NULL.
UPDATE "product_variants" v
SET "optionKey" = k.key
FROM (
  SELECT "variantId", string_agg("optionValueId", ':' ORDER BY "optionValueId" COLLATE "C") AS key
  FROM "variant_option_values"
  GROUP BY "variantId"
) k
WHERE k."variantId" = v.id;

-- CreateIndex
CREATE UNIQUE INDEX "carts_active_user_key" ON "carts"("userId") WHERE (status = 'ACTIVE');

-- CreateIndex
CREATE UNIQUE INDEX "categories_root_name_key" ON "categories"("name") WHERE ("parentId" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_transactionId_key" ON "payments"("provider", "transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_productId_optionKey_key" ON "product_variants"("productId", "optionKey");

-- CreateIndex
CREATE INDEX "products_brandId_idx" ON "products"("brandId");

-- CreateIndex
CREATE INDEX "products_status_deletedAt_idx" ON "products"("status", "deletedAt");
