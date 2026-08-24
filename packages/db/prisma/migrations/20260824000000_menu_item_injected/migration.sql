-- AEH-227: mark injected placeholder cards with a real, readable column.
--
-- Replaces a guard that keyed on an `id` string prefix ("hidden-", "baseline-").
-- That guard was dead: run-estimate persists MenuItems without passing `id`, so
-- Prisma mints a cuid and the pipeline's semantic id is discarded entirely --
-- it is not even kept in `meta`. Additive and non-destructive; every existing
-- row is correctly `false` (verified: 0 of 77 rows on dev/main carry a
-- hidden-work taxonomyKey, so there is nothing to backfill).
ALTER TABLE "MenuItem" ADD COLUMN "injected" BOOLEAN NOT NULL DEFAULT false;
