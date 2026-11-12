-- AlterEnum
ALTER TYPE "OperationStatus" ADD VALUE 'UNKNOWN';

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "humanVerdictsJson" JSONB,
ADD COLUMN     "verificationJson" JSONB;

-- AlterTable
ALTER TABLE "PayPalOperation" ADD COLUMN     "debugId" TEXT,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "path" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "requestBody" JSONB,
ADD COLUMN     "resourceStatus" TEXT,
ADD COLUMN     "seq" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "PayPalOperation_dealId_type_seq_key" ON "PayPalOperation"("dealId", "type", "seq");

-- Settlement safety (hand-written; Prisma cannot express partial indexes):
-- at most ONE live (non-FAILED) money-moving operation (CAPTURE or VOID) per deal.
CREATE UNIQUE INDEX "PayPalOperation_one_live_settlement_per_deal" ON "PayPalOperation"("dealId") WHERE "type" IN ('CAPTURE', 'VOID') AND "status" <> 'FAILED';