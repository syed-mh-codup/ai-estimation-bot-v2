-- Consolidate a preset's effort into ONE dev figure, with side flags for
-- reference only.
--
-- Delivery is full-stack now. The FE/BE split existed to allocate work across
-- separate frontend and backend resources; that need is gone, so maintaining
-- two numbers is upkeep with no consumer.
--
-- The backfill is EXACT, not a guess — every existing row records both figures,
-- so the unified total is their sum and the flags are simply "was there any
-- work on that side". Verified before writing this: of 45 active presets, 24
-- have both, 17 backend-only, 4 frontend-only, 0 neither.
--
-- beHours/feHours are kept and made NULLABLE rather than dropped: the decision
-- to estimate as one figure may be revisited, and the historical split (sourced
-- from docs/Estimate Presets (ISM).xlsx) could not be reconstructed afterwards.
-- NULL on rows created from here on means "split not tracked", which is why
-- nullable and not 0 — 0 would claim there was no work on that side.
ALTER TABLE "PresetVersion" ADD COLUMN "devHours" INTEGER;
ALTER TABLE "PresetVersion" ADD COLUMN "touchesFrontend" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PresetVersion" ADD COLUMN "touchesBackend"  BOOLEAN NOT NULL DEFAULT false;

-- Every row, not just active ones — version history is rendered in the admin UI.
UPDATE "PresetVersion"
SET "devHours"        = COALESCE("beHours", 0) + COALESCE("feHours", 0),
    "touchesBackend"  = COALESCE("beHours", 0) > 0,
    "touchesFrontend" = COALESCE("feHours", 0) > 0;

ALTER TABLE "PresetVersion" ALTER COLUMN "devHours" SET NOT NULL;
ALTER TABLE "PresetVersion" ALTER COLUMN "beHours" DROP NOT NULL;
ALTER TABLE "PresetVersion" ALTER COLUMN "feHours" DROP NOT NULL;
