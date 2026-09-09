-- AEH-238: ledger locks -- the subtractive half of the edit envelope.
--
-- A lock freezes one RoleLineItem's hours, its description and its existence.
-- It binds PEOPLE as well as the AI: this is a permission layer on the ledger
-- that the edit engine happens to also respect, not an AI-only guard. Placement
-- stays free, because MenuItem.sectionId and "order" are presentational and
-- freezing them would stop a reviewer tidying the board.
--
-- Two tables rather than one. LedgerLock is current state, one row per frozen
-- line item, which is what makes "is this frozen" a lookup instead of an
-- aggregate. LockEvent is the append-only history, and it is what the hover
-- affordance reads -- a reviewer needs the story, and a story has to outlive
-- its subject.
--
-- LockEvent."lineItemId" carries NO foreign key, deliberately. The whole point
-- of the table is to outlive the lock, and a cascade from RoleLineItem would
-- delete precisely the record of an override somebody later wants to ask about.

-- CreateEnum
CREATE TYPE "LockScope" AS ENUM ('ESTIMATE', 'SECTION', 'CARD', 'LINE');

-- CreateEnum
CREATE TYPE "LockEventKind" AS ENUM ('LOCKED', 'UNLOCKED', 'OVERRIDDEN');

-- CreateTable
CREATE TABLE "LedgerLock" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "declaredScope" "LockScope" NOT NULL,
    "declaredTargetId" TEXT,
    "lockedById" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LockEvent" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "kind" "LockEventKind" NOT NULL,
    "declaredScope" "LockScope" NOT NULL,
    "declaredTargetId" TEXT,
    "actorId" TEXT NOT NULL,
    "priorHolderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LockEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One lock per row at most. This constraint IS the enforcement guarantee: two
-- concurrent lock calls over overlapping selections cannot produce two locks on
-- the same row, so the loser is a conflict the caller has to handle rather than
-- a duplicate nobody notices.
CREATE UNIQUE INDEX "LedgerLock_lineItemId_key" ON "LedgerLock"("lineItemId");

-- CreateIndex
CREATE INDEX "LedgerLock_estimateId_idx" ON "LedgerLock"("estimateId");

-- CreateIndex
CREATE INDEX "LockEvent_estimateId_lineItemId_createdAt_idx" ON "LockEvent"("estimateId", "lineItemId", "createdAt");

-- AddForeignKey
ALTER TABLE "LedgerLock" ADD CONSTRAINT "LedgerLock_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerLock" ADD CONSTRAINT "LedgerLock_lineItemId_fkey" FOREIGN KEY ("lineItemId") REFERENCES "RoleLineItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerLock" ADD CONSTRAINT "LedgerLock_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LockEvent" ADD CONSTRAINT "LockEvent_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
