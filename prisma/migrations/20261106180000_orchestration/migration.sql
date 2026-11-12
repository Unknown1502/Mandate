-- CreateTable
CREATE TABLE "OrchestrationStep" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STARTED',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "resultJson" JSONB,
    "error" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrchestrationStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationClaim" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "claimedBy" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CLAIMED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrchestrationStep_dealId_idx" ON "OrchestrationStep"("dealId");

-- CreateIndex
CREATE UNIQUE INDEX "OrchestrationStep_dealId_step_idempotencyKey_key" ON "OrchestrationStep"("dealId", "step", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationClaim_deliveryId_sequence_key" ON "VerificationClaim"("deliveryId", "sequence");

-- AddForeignKey
ALTER TABLE "OrchestrationStep" ADD CONSTRAINT "OrchestrationStep_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
