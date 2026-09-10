-- CreateEnum
CREATE TYPE "LineageKind" AS ENUM ('SUCCESSOR', 'BRANCH');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('QUEUED', 'RUNNING', 'PROPOSED', 'APPLIED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProposalKind" AS ENUM ('ADD', 'MODIFY', 'REMOVE');

-- CreateEnum
CREATE TYPE "ProposalDecision" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN     "forkPrompt" TEXT,
ADD COLUMN     "lineageKind" "LineageKind",
ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "EstimateStatement" ADD COLUMN     "carriedFromId" TEXT,
ADD COLUMN     "carriedIntact" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "carriedFromId" TEXT,
ADD COLUMN     "carriedIntact" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "RoleLineItem" ADD COLUMN     "carriedFromId" TEXT,
ADD COLUMN     "carriedIntact" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "EstimateReconciliation" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "posture" "LineageKind" NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" TEXT,
    "pct" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "triagedCardIds" TEXT[],
    "triageReasoning" TEXT,
    "reasoning" TEXT,
    "fingerprint" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "EstimateReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationProposal" (
    "id" TEXT NOT NULL,
    "reconciliationId" TEXT NOT NULL,
    "menuItemId" TEXT,
    "kind" "ProposalKind" NOT NULL,
    "title" TEXT NOT NULL,
    "supersedesMenuItemIds" TEXT[],
    "rationale" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "hoursBefore" DOUBLE PRECISION,
    "hoursAfter" DOUBLE PRECISION,
    "decision" "ProposalDecision" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "ReconciliationProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EstimateReconciliation_estimateId_createdAt_idx" ON "EstimateReconciliation"("estimateId", "createdAt");

-- CreateIndex
CREATE INDEX "EstimateReconciliation_estimateId_status_idx" ON "EstimateReconciliation"("estimateId", "status");

-- CreateIndex
CREATE INDEX "ReconciliationProposal_reconciliationId_decision_idx" ON "ReconciliationProposal"("reconciliationId", "decision");

-- CreateIndex
CREATE INDEX "ReconciliationProposal_menuItemId_idx" ON "ReconciliationProposal"("menuItemId");

-- CreateIndex
CREATE INDEX "Estimate_parentId_idx" ON "Estimate"("parentId");

-- CreateIndex
CREATE INDEX "EstimateStatement_carriedFromId_idx" ON "EstimateStatement"("carriedFromId");

-- CreateIndex
CREATE INDEX "MenuItem_carriedFromId_idx" ON "MenuItem"("carriedFromId");

-- CreateIndex
CREATE INDEX "RoleLineItem_carriedFromId_idx" ON "RoleLineItem"("carriedFromId");

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Estimate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateReconciliation" ADD CONSTRAINT "EstimateReconciliation_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateReconciliation" ADD CONSTRAINT "EstimateReconciliation_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationProposal" ADD CONSTRAINT "ReconciliationProposal_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "EstimateReconciliation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationProposal" ADD CONSTRAINT "ReconciliationProposal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
