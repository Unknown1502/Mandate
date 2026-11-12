-- Terms version history and detector-pin mirrors. ADDITIVE ONLY (one new table, three nullable columns). No existing row is rewritten.
-- Rollback: DROP TABLE "TermsVersion"; ALTER TABLE "Mandate" DROP COLUMN "detectorId", DROP COLUMN "detectorVersion", DROP COLUMN "detectorVocabularyHash";

-- AlterTable
ALTER TABLE "Mandate" ADD COLUMN "detectorId" TEXT,
ADD COLUMN "detectorVersion" TEXT,
ADD COLUMN "detectorVocabularyHash" TEXT;

-- CreateTable
CREATE TABLE "TermsVersion" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "termsSchemaVersion" INTEGER NOT NULL,
    "termsHash" TEXT NOT NULL,
    "termsJson" JSONB NOT NULL,
    "lockedBy" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TermsVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TermsVersion_dealId_version_key" ON "TermsVersion"("dealId", "version");

-- CreateIndex
CREATE INDEX "TermsVersion_termsHash_idx" ON "TermsVersion"("termsHash");

-- AddForeignKey
ALTER TABLE "TermsVersion" ADD CONSTRAINT "TermsVersion_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TermsVersion" ADD CONSTRAINT "TermsVersion_shape_check" CHECK ("version" >= 1 AND "termsSchemaVersion" IN (1, 2) AND "termsHash" ~ '^[0-9a-f]{64}$');
CREATE TRIGGER "TermsVersion_immutable" BEFORE UPDATE OR DELETE ON "TermsVersion" FOR EACH ROW EXECUTE FUNCTION mandate_forbid_mutation();
