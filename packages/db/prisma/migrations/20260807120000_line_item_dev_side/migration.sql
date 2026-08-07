-- Which side of the stack a DEV line item touches. The hours remain a single
-- combined number; these flags describe what that number covers.
--
-- Both default false, i.e. "not tagged". Deliberately NOT backfilled with a
-- guess: existing rows were produced before the specialist knew to tag, and
-- claiming to know their split would be inventing data — the exact failure
-- (fabricated FE hours) this column exists to end. Writeback apportions
-- untagged hours by the library ratio and records that it had to.
ALTER TABLE "RoleLineItem" ADD COLUMN "touchesFrontend" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RoleLineItem" ADD COLUMN "touchesBackend"  BOOLEAN NOT NULL DEFAULT false;
