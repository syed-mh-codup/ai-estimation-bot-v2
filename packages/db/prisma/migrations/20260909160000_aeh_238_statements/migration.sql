-- AEH-238: the narrative and the assumptions become addressable rows.
--
-- They were two String[] columns on Estimate. A bare string in an ordered array
-- has no identity, and three things needed one: locking "assumption 4" would
-- have locked an array INDEX, which stops meaning the same thing the moment a
-- line is inserted above it; an audit snapshot could only ever say "the
-- assumptions changed", never which one or what it said before; and a steered
-- edit aimed at one assumption had nothing to aim at.
--
-- Backfilled before the columns are dropped, in that order, because the
-- opposite order loses every narrative and every assumption in the database.
-- `WITH ORDINALITY` preserves the position they were written in — an estimate's
-- narrative is a sequence of points that builds, not a set.

-- CreateEnum
CREATE TYPE "StatementKind" AS ENUM ('NARRATIVE', 'ASSUMPTION');

-- CreateTable
CREATE TABLE "EstimateStatement" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "kind" "StatementKind" NOT NULL,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "provenance" "LineProvenance" NOT NULL DEFAULT 'CREW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimateStatement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EstimateStatement_estimateId_kind_order_idx" ON "EstimateStatement"("estimateId", "kind", "order");

-- AddForeignKey
ALTER TABLE "EstimateStatement" ADD CONSTRAINT "EstimateStatement_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill the narrative, keeping its order.
--
-- Provenance is CREW for everything that already exists. That is the honest
-- default rather than a guess: the Architect writes the narrative and the
-- specialists collate the assumptions, so the crew is where every one of these
-- lines came from unless somebody edited it — and which ones they edited was
-- never recorded, which is part of why this table exists.
INSERT INTO "EstimateStatement" ("id", "estimateId", "kind", "text", "order", "provenance", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  e."id",
  'NARRATIVE',
  t."text",
  (t."ord" - 1)::int,
  'CREW',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Estimate" e
CROSS JOIN LATERAL unnest(e."narrative") WITH ORDINALITY AS t("text", "ord")
WHERE t."text" IS NOT NULL AND btrim(t."text") <> '';

-- Backfill the assumptions the same way.
INSERT INTO "EstimateStatement" ("id", "estimateId", "kind", "text", "order", "provenance", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  e."id",
  'ASSUMPTION',
  t."text",
  (t."ord" - 1)::int,
  'CREW',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Estimate" e
CROSS JOIN LATERAL unnest(e."assumptions") WITH ORDINALITY AS t("text", "ord")
WHERE t."text" IS NOT NULL AND btrim(t."text") <> '';

-- Only now. The rows above are the only copy from here on.
ALTER TABLE "Estimate" DROP COLUMN "narrative";
ALTER TABLE "Estimate" DROP COLUMN "assumptions";

-- The schema carries `@updatedAt` with no `@default`, so the column default
-- above existed only to give the backfilled rows a value.
ALTER TABLE "EstimateStatement" ALTER COLUMN "updatedAt" DROP DEFAULT;
