-- AlterEnum
ALTER TYPE "DealState" ADD VALUE 'SETTLEMENT_REVIEW';

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "challengeWindowEndsAt" TIMESTAMP(3),
ADD COLUMN     "challengesJson" JSONB,
ADD COLUMN     "reviewDeadline" TIMESTAMP(3);
