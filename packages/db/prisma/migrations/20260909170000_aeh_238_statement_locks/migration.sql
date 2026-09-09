-- AEH-238: statements become lockable, and steerable.
--
-- The last axis of the envelope. The reframe this ticket came from led with
-- "if i want to edit my assumptions", and until now the only thing a person
-- could do to a statement was type it themselves.
--
-- Four parts:
--
--   1. Two new values on LockScope. Statements join the ONE vocabulary of
--      things a person can point at rather than getting a second one, because
--      two vocabularies would eventually disagree about what a declaration
--      means. What they do not share is the role axis — a statement is one
--      sentence, so `roles` is ignored against these values the way it already
--      is for LINE.
--   2. StatementLock: current state, one row per frozen statement.
--   3. LockEvent serves both kinds. One history table, because the hover story
--      and the three-state padlock are the same affordance wherever they
--      appear, and a second table would mean a second implementation of them.
--   4. SCRIBE, the agent that rewrites the statements in an envelope, and
--      REVISE_STATEMENTS, the mode that dispatches it.
--
-- Hand-written, like the rest of this ticket's migrations. `ALTER TYPE ... ADD
-- VALUE` is deliberately kept in a file that never USES the new value: Postgres
-- allows the addition inside a transaction but not a reference to it, and
-- Prisma runs each migration file as one transaction.

-- ── 1. The statement axes ────────────────────────────────────────────────────

-- AlterEnum
ALTER TYPE "LockScope" ADD VALUE 'STATEMENT';
ALTER TYPE "LockScope" ADD VALUE 'STATEMENT_LIST';

-- AlterEnum
ALTER TYPE "LedgerEditMode" ADD VALUE 'REVISE_STATEMENTS';

-- AlterEnum
ALTER TYPE "AgentKind" ADD VALUE 'SCRIBE';

-- AlterEnum
ALTER TYPE "UsageKind" ADD VALUE 'SCRIBE';

-- ── 2. StatementLock ─────────────────────────────────────────────────────────
--
-- A second current-state table rather than widening LedgerLock.lineItemId to
-- hold either kind of id. That column's UNIQUE plus its cascading foreign key
-- IS the enforcement guarantee: it is what makes "is this frozen" a lookup, and
-- what stops two concurrent lock calls over overlapping selections producing
-- two locks on one row. Making it nullable would trade a real guarantee for the
-- appearance of tidiness.

-- CreateTable
CREATE TABLE "StatementLock" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "declaredScope" "LockScope" NOT NULL,
    "declaredTargetId" TEXT,
    "lockedById" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StatementLock_statementId_key" ON "StatementLock"("statementId");

-- CreateIndex
CREATE INDEX "StatementLock_estimateId_idx" ON "StatementLock"("estimateId");

-- AddForeignKey
ALTER TABLE "StatementLock" ADD CONSTRAINT "StatementLock_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade is for the case that is genuinely a deletion: the estimate going
-- away, or the statement being deleted through a path the guard allowed. It is
-- NOT the enforcement path for a reworded statement — `reconcileStatements`
-- matches by text, so a reword is a delete plus a create, and letting the
-- cascade handle that would silently drop the lock instead of refusing the
-- edit. The refusal happens above this, before the reconcile runs.
ALTER TABLE "StatementLock" ADD CONSTRAINT "StatementLock_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "EstimateStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementLock" ADD CONSTRAINT "StatementLock_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. One history table for both ────────────────────────────────────────────

-- AlterTable
ALTER TABLE "LockEvent" ALTER COLUMN "lineItemId" DROP NOT NULL;
ALTER TABLE "LockEvent" ADD COLUMN "statementId" TEXT;

-- An event about neither thing, or about both, is not auditable. Prisma cannot
-- express this, so it is stated here — the columns are nullable individually
-- precisely because exactly one of them is required.
ALTER TABLE "LockEvent" ADD CONSTRAINT "LockEvent_one_subject"
  CHECK ((("lineItemId" IS NOT NULL)::int + ("statementId" IS NOT NULL)::int) = 1);

-- CreateIndex
CREATE INDEX "LockEvent_estimateId_statementId_createdAt_idx" ON "LockEvent"("estimateId", "statementId", "createdAt");

-- ── 4. The statement write set ───────────────────────────────────────────────

-- AlterTable
ALTER TABLE "LedgerEdit" ADD COLUMN "pinnedStatementIds" TEXT[];
