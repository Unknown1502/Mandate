-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "artifactReference" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "artifactSize" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "manifestHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "manifestJson" JSONB,
ADD COLUMN     "mediaType" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "parseSummaryJson" JSONB,
ADD COLUMN     "parserVersion" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "sellerPrincipalId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "termsHash" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "VerificationRun" (
    "id" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "termsHash" TEXT NOT NULL,
    "artifactSha256" TEXT NOT NULL,
    "verifierVersion" TEXT NOT NULL,
    "overall" TEXT NOT NULL,
    "resultJson" JSONB NOT NULL,
    "resultHash" TEXT NOT NULL,
    "inputEvidenceRefs" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VerificationRun_verificationId_key" ON "VerificationRun"("verificationId");

-- CreateIndex
CREATE INDEX "VerificationRun_dealId_idx" ON "VerificationRun"("dealId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationRun_deliveryId_sequence_key" ON "VerificationRun"("deliveryId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_dealId_key" ON "Delivery"("dealId");

-- AddForeignKey
ALTER TABLE "VerificationRun" ADD CONSTRAINT "VerificationRun_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationRun" ADD CONSTRAINT "VerificationRun_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Immutability (hand-written; Prisma cannot express triggers): deliveries and verification runs are append-only evidence.
CREATE OR REPLACE FUNCTION mandate_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'MANDATE: % rows are immutable', TG_TABLE_NAME USING ERRCODE = '23000';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "VerificationRun_immutable" BEFORE UPDATE OR DELETE ON "VerificationRun" FOR EACH ROW EXECUTE FUNCTION mandate_forbid_mutation();
CREATE TRIGGER "Delivery_immutable" BEFORE UPDATE OR DELETE ON "Delivery" FOR EACH ROW EXECUTE FUNCTION mandate_forbid_mutation();