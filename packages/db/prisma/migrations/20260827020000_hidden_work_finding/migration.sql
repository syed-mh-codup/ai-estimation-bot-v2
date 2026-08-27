-- AEH-263: persist what the Detective found, and what became of it.
--
-- RiskFindings were never stored. A run kept `agentState.detectiveRiskCount` and
-- threw the findings themselves away, so the reasoning behind an estimate died
-- with the run that produced it -- there was no way to ask afterwards what was
-- spotted, what got costed, or what someone knowingly walked away from.
--
-- This table is what makes "hidden work versus work that was asked for" a query
-- rather than a reconstruction, and it is the state the finalise gate counts.
--
-- Unique on (estimateId, riskFlag): the same worry raised against two
-- requirements is one piece of work, and a re-run must neither duplicate a row
-- nor overwrite a decision a human already made about it.
CREATE TYPE "HiddenWorkOutcome" AS ENUM ('OPEN', 'AUTO_COST', 'ACCEPTED', 'COVERED', 'DISMISSED');

CREATE TABLE "HiddenWorkFinding" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "riskFlag" TEXT NOT NULL,
    "known" BOOLEAN NOT NULL DEFAULT false,
    "claim" TEXT NOT NULL,
    "citation" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "taxonomyKey" TEXT,
    "outcome" "HiddenWorkOutcome" NOT NULL DEFAULT 'OPEN',
    "menuItemId" TEXT,
    "dismissReason" TEXT,
    "dismissedById" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HiddenWorkFinding_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HiddenWorkFinding_estimateId_idx" ON "HiddenWorkFinding"("estimateId");
CREATE UNIQUE INDEX "HiddenWorkFinding_estimateId_riskFlag_key" ON "HiddenWorkFinding"("estimateId", "riskFlag");

ALTER TABLE "HiddenWorkFinding" ADD CONSTRAINT "HiddenWorkFinding_estimateId_fkey"
    FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
