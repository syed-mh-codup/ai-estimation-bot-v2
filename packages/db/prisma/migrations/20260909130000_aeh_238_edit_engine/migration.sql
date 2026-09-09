-- AEH-238: the steered-edit engine's schema.
--
-- Four changes that land together because they are one mechanism:
--
--   1. RoleLineItem.edited becomes RoleLineItem.provenance, with three answers
--      where there were two.
--   2. updatedAt on MenuItem and RoleLineItem, which is the region staleness
--      fingerprint.
--   3. LedgerEdit: the request, the pinned write set, the job, and the record.
--   4. ModelUsage.ledgerEditId, so what a steered edit cost is a join.
--
-- Hand-written rather than generated, because `prisma migrate diff` gets two
-- things wrong here and both are silent:
--
--   It emits DROP COLUMN "edited" with no backfill, so every "a human typed
--   this" flag in the database would be thrown away — the exact signal the
--   provenance column exists to preserve.
--
--   It emits ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL with no default,
--   which cannot succeed against a populated table.

-- CreateEnum
CREATE TYPE "LineProvenance" AS ENUM ('CREW', 'HUMAN', 'STEERED');

-- CreateEnum
CREATE TYPE "LedgerEditStatus" AS ENUM ('QUEUED', 'RUNNING', 'PENDING_CONFLICT', 'APPLIED', 'REVERTED', 'DISCARDED', 'FAILED');

-- ── 1. provenance replaces edited ────────────────────────────────────────────
--
-- Added, backfilled, and only then is the old column dropped. The order is the
-- whole point: reading `edited` after dropping it is not possible, and a
-- generated migration would have done exactly that.

-- AlterTable
ALTER TABLE "RoleLineItem" ADD COLUMN "provenance" "LineProvenance" NOT NULL DEFAULT 'CREW';

-- Backfill. `edited = true` meant "a person typed this number", which is
-- precisely HUMAN. `false` meant the estimator council produced it, which is
-- CREW — already the column default, so only the true case needs a statement.
-- Nothing in the database can be STEERED yet: this migration is what makes
-- steering possible.
UPDATE "RoleLineItem" SET "provenance" = 'HUMAN' WHERE "edited" = true;

-- AlterTable
ALTER TABLE "RoleLineItem" DROP COLUMN "edited";

-- ── 2. The region staleness fingerprint ──────────────────────────────────────
--
-- Added WITH a default so existing rows get a value, then the default is
-- dropped so the column matches the schema, where `@updatedAt` carries no
-- `@default`. Prisma's client supplies the value on every create and update, so
-- nothing is left relying on the database to fill it in.
--
-- Existing rows all get the migration's own timestamp. That is honest: when
-- each of them last changed is not recorded anywhere, and the fingerprint only
-- ever compares a region against ITSELF across the span of one job, so a
-- uniform starting point costs nothing.

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "MenuItem" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "RoleLineItem" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "RoleLineItem" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- ── 3. LedgerEdit ────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "ModelUsage" ADD COLUMN "ledgerEditId" TEXT;

-- CreateTable
CREATE TABLE "LedgerEdit" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "declaredScope" "LockScope" NOT NULL,
    "declaredTargetId" TEXT,
    "roles" "RoleKind"[],
    "pinnedLineItemIds" TEXT[],
    "pinnedCardIds" TEXT[],
    "fingerprint" TIMESTAMP(3),
    "status" "LedgerEditStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" TEXT,
    "pct" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "reasoning" TEXT,
    "beforeSnapshot" JSONB,
    "afterSnapshot" JSONB,
    "rowsBefore" INTEGER,
    "rowsAfter" INTEGER,
    "hoursBefore" DOUBLE PRECISION,
    "hoursAfter" DOUBLE PRECISION,
    "overwroteConflict" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),
    "revertedById" TEXT,

    CONSTRAINT "LedgerEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerEdit_estimateId_createdAt_idx" ON "LedgerEdit"("estimateId", "createdAt");

-- CreateIndex
-- The progress UI polls for whatever is in flight on this estimate, so status
-- is queried alongside the estimate rather than on its own.
CREATE INDEX "LedgerEdit_estimateId_status_idx" ON "LedgerEdit"("estimateId", "status");

-- CreateIndex
CREATE INDEX "ModelUsage_ledgerEditId_idx" ON "ModelUsage"("ledgerEditId");

-- AddForeignKey
ALTER TABLE "LedgerEdit" ADD CONSTRAINT "LedgerEdit_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEdit" ADD CONSTRAINT "LedgerEdit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull, like estimateId and artifactId on this table: the spend record must
-- outlive what it was spent on.
ALTER TABLE "ModelUsage" ADD CONSTRAINT "ModelUsage_ledgerEditId_fkey" FOREIGN KEY ("ledgerEditId") REFERENCES "LedgerEdit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
