-- P3 (V2 writers + TermsAttestation) and P4 lineage columns. ADDITIVE ONLY: no existing column is altered or dropped, no row is rewritten,
-- every new column on an existing table is nullable or has a constant default (a metadata-only change in PostgreSQL 11+).
-- Rollback: see docs/16-v2-lifecycle.md (section "Migration and rollback"): the new objects are unused by V1 code paths, so they can be dropped
-- after V2 mandates/deals are withdrawn; nothing here is required to read or settle any V1 record.

-- AlterTable
ALTER TABLE "Mandate" ADD COLUMN "sealVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "languagePolicyHash" TEXT,
ADD COLUMN "mandateNonce" TEXT;

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN "termsSchemaVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "languagePolicyHash" TEXT;

-- AlterTable
ALTER TABLE "VerificationRun" ADD COLUMN "termsSchemaVersion" INTEGER,
ADD COLUMN "bindingHash" TEXT;

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN "inputManifestHash" TEXT;

-- CreateTable
CREATE TABLE "TermsAttestation" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "mandateDigest" TEXT NOT NULL,
    "termsHash" TEXT NOT NULL,
    "termsSchemaVersion" INTEGER NOT NULL,
    "languagePolicyHash" TEXT,
    "mappingHash" TEXT NOT NULL,
    "approvalKind" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "approvalNonce" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TermsAttestation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Mandate_mandateNonce_key" ON "Mandate"("mandateNonce");

-- CreateIndex
CREATE INDEX "VerificationRun_bindingHash_idx" ON "VerificationRun"("bindingHash");

-- CreateIndex
CREATE UNIQUE INDEX "TermsAttestation_dealId_key" ON "TermsAttestation"("dealId");

-- CreateIndex
CREATE UNIQUE INDEX "TermsAttestation_approvalNonce_key" ON "TermsAttestation"("approvalNonce");

-- CreateIndex
CREATE INDEX "TermsAttestation_mandateId_idx" ON "TermsAttestation"("mandateId");

-- AddForeignKey
ALTER TABLE "TermsAttestation" ADD CONSTRAINT "TermsAttestation_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity checks that Prisma cannot express (hand-written). They constrain ONLY the new V2 values; V1 rows (sealVersion = 1, nonce NULL) satisfy them trivially.
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_v2_identity_check"
  CHECK (("sealVersion" = 1 AND "mandateNonce" IS NULL) OR ("sealVersion" = 2 AND "schemaVersion" = 2 AND "mandateNonce" ~ '^[0-9a-f]{32}$' AND "id" ~ '^c[a-z0-9]{24}$'));
ALTER TABLE "TermsAttestation" ADD CONSTRAINT "TermsAttestation_shape_check"
  CHECK ("approvalKind" = 'HUMAN_PREAUTH' AND "actorKind" = 'human' AND "termsSchemaVersion" = 2 AND "approvalNonce" ~ '^[0-9a-f]{32}$');

-- Immutability: an attestation is evidence and is never updated or deleted (same function as VerificationRun / Delivery).
CREATE TRIGGER "TermsAttestation_immutable" BEFORE UPDATE OR DELETE ON "TermsAttestation" FOR EACH ROW EXECUTE FUNCTION mandate_forbid_mutation();
