-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "needsHumanFrom" "DealState",
ADD COLUMN     "needsHumanReason" TEXT,
ADD COLUMN     "negotiationRounds" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "NegotiationMessage" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "sender" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NegotiationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NegotiationMessage_dealId_round_idx" ON "NegotiationMessage"("dealId", "round");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetReservation_dealId_key" ON "BudgetReservation"("dealId");

-- AddForeignKey
ALTER TABLE "NegotiationMessage" ADD CONSTRAINT "NegotiationMessage_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

