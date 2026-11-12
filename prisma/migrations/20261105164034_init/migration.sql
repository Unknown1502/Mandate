-- CreateEnum
CREATE TYPE "DealState" AS ENUM ('PROPOSED', 'NEGOTIATING', 'TERMS_LOCKED', 'POLICY_CHECKED', 'BLOCKED', 'NEEDS_HUMAN', 'ORDER_CREATED', 'AWAITING_BUYER_APPROVAL', 'AUTHORIZED', 'AWAITING_DELIVERY', 'DELIVERED', 'VERIFYING', 'SETTLING', 'SETTLEMENT_PENDING', 'CAPTURED', 'PARTIALLY_CAPTURED', 'VOIDED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "OperationType" AS ENUM ('CREATE_ORDER', 'AUTHORIZE', 'CAPTURE', 'VOID', 'REAUTHORIZE');

-- CreateEnum
CREATE TYPE "OperationStatus" AS ENUM ('PLANNED', 'SENT', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'RELEASED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mandate" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "budgetTotal" DECIMAL(14,2) NOT NULL,
    "perDealMax" DECIMAL(14,2) NOT NULL,
    "requireHumanAbove" DECIMAL(14,2),
    "allowedTaskTypes" TEXT[],
    "counterparties" TEXT[],
    "injectionPolicy" TEXT NOT NULL DEFAULT 'HUMAN_REVIEW',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "canonicalJson" TEXT NOT NULL,
    "mandateDigest" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "approvalMethod" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mandate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "state" "DealState" NOT NULL DEFAULT 'PROPOSED',
    "sellerId" TEXT NOT NULL,
    "termsJson" JSONB,
    "termsHash" TEXT,
    "price" DECIMAL(14,2),
    "paypalOrderId" TEXT,
    "paypalAuthId" TEXT,
    "paypalAuthStatus" TEXT,
    "authorizedAt" TIMESTAMP(3),
    "authExpiresAt" TIMESTAMP(3),
    "approvalUrl" TEXT,
    "capturedAmount" DECIMAL(14,2),
    "paypalCaptureId" TEXT,
    "deadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetReservation" (
    "id" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayPalOperation" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "type" "OperationType" NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestBodyHash" TEXT NOT NULL,
    "status" "OperationStatus" NOT NULL DEFAULT 'PLANNED',
    "paypalResourceId" TEXT,
    "responseStatus" INTEGER,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayPalOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealEvent" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "artifactSha256" TEXT NOT NULL,
    "artifactText" TEXT NOT NULL,
    "resultsJson" JSONB,
    "flagsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "earned" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reasonCodes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaypalCall" (
    "id" TEXT NOT NULL,
    "dealId" TEXT,
    "endpoint" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "debugId" TEXT,
    "requestId" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaypalCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "resourceType" TEXT,
    "resourceId" TEXT,
    "dealId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dealId" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "dealId" TEXT,
    "role" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "outputJson" JSONB NOT NULL,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttackRun" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "runIndex" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "detailJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttackRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_paypalOrderId_key" ON "Deal"("paypalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_paypalAuthId_key" ON "Deal"("paypalAuthId");

-- CreateIndex
CREATE INDEX "BudgetReservation_mandateId_status_idx" ON "BudgetReservation"("mandateId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PayPalOperation_requestId_key" ON "PayPalOperation"("requestId");

-- CreateIndex
CREATE INDEX "PayPalOperation_dealId_type_idx" ON "PayPalOperation"("dealId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "DealEvent_dealId_seq_key" ON "DealEvent"("dealId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_dealId_key" ON "Settlement"("dealId");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- AddForeignKey
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "Mandate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetReservation" ADD CONSTRAINT "BudgetReservation_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "Mandate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetReservation" ADD CONSTRAINT "BudgetReservation_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayPalOperation" ADD CONSTRAINT "PayPalOperation_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealEvent" ADD CONSTRAINT "DealEvent_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
