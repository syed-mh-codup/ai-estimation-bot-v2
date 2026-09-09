-- AEH-238: what kind of change was asked for.
--
-- A column rather than something inferred from the instruction. Re-pricing a
-- slice and reshaping the cards are different jobs with different write paths,
-- and reading which one somebody meant out of their prose is exactly the
-- guesswork the declared envelope exists to remove.
--
-- Defaults to REPRICE so every edit written before this column existed reads as
-- what it actually was.

-- CreateEnum
CREATE TYPE "LedgerEditMode" AS ENUM ('REPRICE', 'RESTRUCTURE', 'RESTRUCTURE_KEEP_HOURS');

-- AlterTable
ALTER TABLE "LedgerEdit" ADD COLUMN "mode" "LedgerEditMode" NOT NULL DEFAULT 'REPRICE';
