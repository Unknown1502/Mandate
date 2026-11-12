-- P7 (detector governance). ADDITIVE ONLY: two new tables, nothing existing is altered. V1 and V2 mandates/deals do not depend on them to be read or settled.
-- Rollback: DROP TABLE "DetectorReleaseEvent"; DROP TABLE "DetectorRelease"; DROP FUNCTION mandate_detector_release_guard(); (V2 LLM deals then lose their release
-- check and fail closed: no detector is "permitted" without a verified release snapshot). See docs/16-v2-lifecycle.md.

-- CreateTable
CREATE TABLE "DetectorRelease" (
    "id" TEXT NOT NULL,
    "detectorId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "vocabularyHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "languageCoverage" TEXT[],
    "evaluationDatasetVersion" TEXT NOT NULL,
    "manifestJson" JSONB NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DetectorRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetectorReleaseEvent" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DetectorReleaseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DetectorRelease_detectorId_version_key" ON "DetectorRelease"("detectorId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DetectorRelease_detectorId_vocabularyHash_key" ON "DetectorRelease"("detectorId", "vocabularyHash");

-- CreateIndex
CREATE UNIQUE INDEX "DetectorReleaseEvent_releaseId_seq_key" ON "DetectorReleaseEvent"("releaseId", "seq");

-- AddForeignKey
ALTER TABLE "DetectorReleaseEvent" ADD CONSTRAINT "DetectorReleaseEvent_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "DetectorRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Shape checks (hand-written; Prisma cannot express them)
ALTER TABLE "DetectorRelease" ADD CONSTRAINT "DetectorRelease_shape_check"
  CHECK ("version" ~ '^[0-9]+\.[0-9]+\.[0-9]+$' AND "vocabularyHash" ~ '^sha256:[0-9a-f]{64}$' AND "contentHash" ~ '^[0-9a-f]{64}$'
         AND "status" IN ('DRAFT','EVALUATION','REVIEW','APPROVED','RELEASED','RETIRED','REVOKED'));

-- Governance guard: a release row is immutable except for `status` (and its timestamp), status moves only along the workflow, and rows are never deleted.
CREATE OR REPLACE FUNCTION mandate_detector_release_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MANDATE: detector releases are immutable (no delete)' USING ERRCODE = '23000';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."detectorId" <> OLD."detectorId" OR NEW."version" <> OLD."version" OR NEW."vocabularyHash" <> OLD."vocabularyHash"
     OR NEW."contentHash" <> OLD."contentHash" OR NEW."languageCoverage" <> OLD."languageCoverage"
     OR NEW."evaluationDatasetVersion" <> OLD."evaluationDatasetVersion" OR NEW."manifestJson" <> OLD."manifestJson"
     OR NEW."submittedBy" <> OLD."submittedBy" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'MANDATE: detector release content is immutable (only status may change)' USING ERRCODE = '23000';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'DRAFT'      AND NEW."status" IN ('EVALUATION'))
    OR (OLD."status" = 'EVALUATION' AND NEW."status" IN ('REVIEW','REVOKED'))
    OR (OLD."status" = 'REVIEW'     AND NEW."status" IN ('APPROVED','REVOKED'))
    OR (OLD."status" = 'APPROVED'   AND NEW."status" IN ('RELEASED','RETIRED','REVOKED'))
    OR (OLD."status" = 'RELEASED'   AND NEW."status" IN ('RETIRED','REVOKED'))
    OR (OLD."status" = 'RETIRED'    AND NEW."status" IN ('RELEASED','REVOKED'))
  ) THEN
    RAISE EXCEPTION 'MANDATE: illegal detector release status transition % -> %', OLD."status", NEW."status" USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DetectorRelease_guard" BEFORE UPDATE OR DELETE ON "DetectorRelease" FOR EACH ROW EXECUTE FUNCTION mandate_detector_release_guard();

-- The release log is evidence: never updated or deleted.
CREATE TRIGGER "DetectorReleaseEvent_immutable" BEFORE UPDATE OR DELETE ON "DetectorReleaseEvent" FOR EACH ROW EXECUTE FUNCTION mandate_forbid_mutation();
