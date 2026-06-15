-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN     "ingestError" TEXT,
ADD COLUMN     "ingestPct" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ingestStage" TEXT,
ADD COLUMN     "ingestStatus" "RunStatus" NOT NULL DEFAULT 'IDLE';
