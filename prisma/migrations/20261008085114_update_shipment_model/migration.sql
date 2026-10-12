-- Shipment.carrier: free-text String? -> required CourierCarrier enum, plus
-- courier reference fields. Existing carrier text is mapped onto the enum
-- instead of being dropped; the migration aborts (and changes nothing) if any
-- shipment has a carrier that can't be mapped, so it never loses data.

-- CreateEnum
CREATE TYPE "CourierCarrier" AS ENUM ('PATHAO', 'REDX', 'STEADFAST', 'CARRYBEE');

-- New courier reference fields
ALTER TABLE "shipments" ADD COLUMN "codAmount" DECIMAL(12,2),
ADD COLUMN "consignmentId" TEXT,
ADD COLUMN "merchantOrderId" TEXT;

-- Convert carrier in place: "Pathao", " red-x ", "Steadfast Courier" etc.
ALTER TABLE "shipments" RENAME COLUMN "carrier" TO "carrier_legacy";
ALTER TABLE "shipments" ADD COLUMN "carrier" "CourierCarrier";

UPDATE "shipments"
SET "carrier" = CASE
  WHEN regexp_replace(upper("carrier_legacy"), '[^A-Z]', '', 'g') LIKE 'PATHAO%' THEN 'PATHAO'
  WHEN regexp_replace(upper("carrier_legacy"), '[^A-Z]', '', 'g') LIKE 'REDX%' THEN 'REDX'
  WHEN regexp_replace(upper("carrier_legacy"), '[^A-Z]', '', 'g') LIKE 'STEADFAST%' THEN 'STEADFAST'
  WHEN regexp_replace(upper("carrier_legacy"), '[^A-Z]', '', 'g') LIKE 'CARRYBEE%' THEN 'CARRYBEE'
END::"CourierCarrier";

DO $$
DECLARE
  unmapped TEXT;
BEGIN
  SELECT string_agg(DISTINCT coalesce("carrier_legacy", '<null>'), ', ')
  INTO unmapped
  FROM "shipments"
  WHERE "carrier" IS NULL;

  IF unmapped IS NOT NULL THEN
    RAISE EXCEPTION 'shipments.carrier has values that do not map to CourierCarrier: %. Fix those rows, then re-run the migration.', unmapped;
  END IF;
END $$;

ALTER TABLE "shipments" ALTER COLUMN "carrier" SET NOT NULL;
ALTER TABLE "shipments" DROP COLUMN "carrier_legacy";
