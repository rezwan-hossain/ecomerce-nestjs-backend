/*
  Warnings:

  - You are about to drop the column `processedBy` on the `refund_requests` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "refund_requests" DROP COLUMN "processedBy",
ADD COLUMN     "processedByUserId" TEXT,
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12,2);

-- CreateIndex
CREATE INDEX "refund_requests_processedByUserId_idx" ON "refund_requests"("processedByUserId");

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_processedByUserId_fkey" FOREIGN KEY ("processedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
