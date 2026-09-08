-- AEH-335: the PM/BA/QA buffers become a per-estimate lever.
--
-- Three nullable percent columns on Estimate, absolute rather than deltas, in
-- the whole-percent convention EstimationConfig already uses (20 means 20%).
-- NULL means inherit, and inherit resolves against the estimate's own
-- `configVersion` -- not whichever config row happens to be active. That
-- distinction is the point: the read path used to take the active config, so an
-- estimate pinned to v3 picked up v4 rates on any line edited after v4 was
-- activated and its stored hours silently became a mix of two config versions.

-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN     "baCommunicationTaxPctOverride" DOUBLE PRECISION,
ADD COLUMN     "overheadRatesStale" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pmCommunicationTaxPctOverride" DOUBLE PRECISION,
ADD COLUMN     "qaRegressionBufferPctOverride" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "overhead" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EstimateTaxChange" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "role" "RoleKind" NOT NULL,
    "fromPct" DOUBLE PRECISION,
    "toPct" DOUBLE PRECISION,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimateTaxChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EstimateTaxChange_estimateId_idx" ON "EstimateTaxChange"("estimateId");

-- AddForeignKey
ALTER TABLE "EstimateTaxChange" ADD CONSTRAINT "EstimateTaxChange_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill MenuItem.overhead for cards that already exist.
--
-- Not cosmetic: a buffer tweak re-taxes a role's line items, and a delivery
-- overhead card's hours are ALREADY a percentage of taxed hours
-- (injectProcessOverhead). Re-taxing one compounds a percentage on a
-- percentage, so every historical overhead card has to be recognisable before
-- the first tweak lands, or the first tweak inflates it.
--
-- The predicate is exact rather than heuristic. Overhead cards are the only
-- injected cards that can carry a `process.*` key: those TaxonomyNode rows are
-- all `classifiable = false` (see 20260827010000_taxonomy_classifiable), which
-- keeps them out of the Librarian's vocabulary entirely, so no asked-for or
-- hidden-work card can ever land on one.
UPDATE "MenuItem"
   SET "overhead" = true
 WHERE "injected" = true
   AND "taxonomyKey" LIKE 'process.%';
