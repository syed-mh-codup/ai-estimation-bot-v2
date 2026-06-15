-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('IDLE', 'RUNNING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN     "runError" TEXT,
ADD COLUMN     "runFinishedAt" TIMESTAMP(3),
ADD COLUMN     "runPct" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "runStage" TEXT,
ADD COLUMN     "runStartedAt" TIMESTAMP(3),
ADD COLUMN     "runStatus" "RunStatus" NOT NULL DEFAULT 'IDLE';
