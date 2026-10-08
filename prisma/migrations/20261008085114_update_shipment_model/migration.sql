/*
  Warnings:

  - Added the required column `carrier` to the `shipments` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "CourierCarrier" AS ENUM ('PATHAO', 'REDX', 'STEADFAST', 'CARRYBEE');

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "codAmount" DECIMAL(12,2),
ADD COLUMN     "consignmentId" TEXT,
ADD COLUMN     "merchantOrderId" TEXT,
DROP COLUMN "carrier",
ADD COLUMN     "carrier" "CourierCarrier" NOT NULL;
