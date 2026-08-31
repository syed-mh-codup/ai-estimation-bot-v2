-- AEH-244 rework: PresetRetrieval and PresetComposition become per-version
-- (like PresetAnchor), and the retrieval surface becomes self-contained by
-- absorbing `notes` and `userStoryTags` from the anchor. A rename or keyword
-- edit is now a new version with real history instead of an in-place overwrite.

-- ── PresetRetrieval ───────────────────────────────────────────────────────────
-- 1. Link each retrieval row to a version (active preferred, else latest).
ALTER TABLE "PresetRetrieval" ADD COLUMN "presetVersionId" TEXT;

UPDATE "PresetRetrieval" r
SET "presetVersionId" = (
  SELECT v.id
  FROM "PresetVersion" v
  WHERE v."presetId" = r."presetId"
  ORDER BY v.active DESC, v.version DESC
  LIMIT 1
);

-- 2. Add the two embedding fields and backfill them from the anchor.
ALTER TABLE "PresetRetrieval" ADD COLUMN "userStoryTags" TEXT[];
ALTER TABLE "PresetRetrieval" ADD COLUMN "notes" TEXT;

UPDATE "PresetRetrieval" r
SET "userStoryTags" = a."userStoryTags",
    "notes" = a."notes"
FROM "PresetAnchor" a
WHERE a."presetVersionId" = r."presetVersionId";

-- 3. Tighten to non-null now that every row is populated.
ALTER TABLE "PresetRetrieval" ALTER COLUMN "presetVersionId" SET NOT NULL;
ALTER TABLE "PresetRetrieval" ALTER COLUMN "userStoryTags" SET NOT NULL;
ALTER TABLE "PresetRetrieval" ALTER COLUMN "notes" SET NOT NULL;

-- 4. Drop the old per-preset key and re-key on the version.
ALTER TABLE "PresetRetrieval" DROP CONSTRAINT "PresetRetrieval_presetId_fkey";
DROP INDEX "PresetRetrieval_presetId_key";
ALTER TABLE "PresetRetrieval" DROP COLUMN "presetId";

CREATE UNIQUE INDEX "PresetRetrieval_presetVersionId_key" ON "PresetRetrieval"("presetVersionId");
ALTER TABLE "PresetRetrieval" ADD CONSTRAINT "PresetRetrieval_presetVersionId_fkey"
  FOREIGN KEY ("presetVersionId") REFERENCES "PresetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── PresetComposition ─────────────────────────────────────────────────────────
ALTER TABLE "PresetComposition" ADD COLUMN "presetVersionId" TEXT;

UPDATE "PresetComposition" c
SET "presetVersionId" = (
  SELECT v.id
  FROM "PresetVersion" v
  WHERE v."presetId" = c."presetId"
  ORDER BY v.active DESC, v.version DESC
  LIMIT 1
);

ALTER TABLE "PresetComposition" ALTER COLUMN "presetVersionId" SET NOT NULL;

ALTER TABLE "PresetComposition" DROP CONSTRAINT "PresetComposition_presetId_fkey";
DROP INDEX "PresetComposition_presetId_key";
ALTER TABLE "PresetComposition" DROP COLUMN "presetId";

CREATE UNIQUE INDEX "PresetComposition_presetVersionId_key" ON "PresetComposition"("presetVersionId");
ALTER TABLE "PresetComposition" ADD CONSTRAINT "PresetComposition_presetVersionId_fkey"
  FOREIGN KEY ("presetVersionId") REFERENCES "PresetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── PresetAnchor: notes + userStoryTags moved to retrieval ────────────────────
ALTER TABLE "PresetAnchor" DROP COLUMN "notes";
ALTER TABLE "PresetAnchor" DROP COLUMN "userStoryTags";
