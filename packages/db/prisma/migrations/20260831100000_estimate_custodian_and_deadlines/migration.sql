-- AEH-240: a custodian, a deadline, and the reminders that make the deadline mean
-- something.
--
-- `ownerId` has only ever meant "who created this". Custody is the other half:
-- who is answerable for moving it along right now. They are separate columns
-- because they move for different reasons -- ownership is reassigned in bulk
-- when somebody leaves (admin/users), custody is handed over for a fortnight's
-- leave -- and only custody re-points the reminders.
--
-- SET NULL on the custodian FK, not RESTRICT: unlike ownership, custody is not
-- history worth preserving, so deleting a user must not be blocked by it. The
-- estimate falls back to notifying its owner, which is the same behaviour as an
-- estimate nobody has taken custody of.
--
-- EstimateReminder exists so the daily sweep can be retried. It runs inside one
-- Inngest step; without a row the database refuses to duplicate, a crash after
-- the tenth email would re-send all ten on retry.
CREATE TYPE "ReminderKind" AS ENUM ('DUE_SOON', 'DUE_TODAY', 'OVERDUE');

ALTER TABLE "Estimate" ADD COLUMN "custodianId" TEXT;
ALTER TABLE "Estimate" ADD COLUMN "dueAt" TIMESTAMP(3);

ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_custodianId_fkey"
    FOREIGN KEY ("custodianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "EstimateReminder" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "kind" "ReminderKind" NOT NULL,
    "sentTo" TEXT NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimateReminder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EstimateReminder_estimateId_idx" ON "EstimateReminder"("estimateId");
CREATE UNIQUE INDEX "EstimateReminder_estimateId_kind_key" ON "EstimateReminder"("estimateId", "kind");

ALTER TABLE "EstimateReminder" ADD CONSTRAINT "EstimateReminder_estimateId_fkey"
    FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
