-- AEH-242 — dependency edges become first class.
--
-- `PresetComposition.requires` and `.blocks` held preset CODES as untyped string
-- arrays: no foreign key, no enforced direction, and no way to attach a reason.
-- They expressed the same relation from opposite ends and were maintained
-- independently, so they had drifted apart — of the 88 edges in the library at
-- the time of this migration, 35 existed only in `blocks` and 19 only in
-- `requires`, and their union contained a cycle (P27 -> P34 -> P38 -> P27) that
-- nothing in the codebase could have caught.
--
-- Deliberately NOT a data migration. The xlsx-seeded library is being retired
-- and replaced wholesale, so these edges are dropped rather than carried across.
-- A reference snapshot of them is kept in `docs/preset-dependency-reference.md`
-- for fixture and UX design work; it is not to be re-seeded.

-- CreateTable
CREATE TABLE "PresetDependency" (
    "id" TEXT NOT NULL,
    "dependentVersionId" TEXT NOT NULL,
    "prerequisitePresetId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PresetDependency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PresetDependency_prerequisitePresetId_idx" ON "PresetDependency"("prerequisitePresetId");

-- CreateIndex
CREATE UNIQUE INDEX "PresetDependency_dependentVersionId_prerequisitePresetId_key" ON "PresetDependency"("dependentVersionId", "prerequisitePresetId");

-- AddForeignKey
ALTER TABLE "PresetDependency" ADD CONSTRAINT "PresetDependency_dependentVersionId_fkey" FOREIGN KEY ("dependentVersionId") REFERENCES "PresetVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresetDependency" ADD CONSTRAINT "PresetDependency_prerequisitePresetId_fkey" FOREIGN KEY ("prerequisitePresetId") REFERENCES "Preset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "PresetComposition" DROP COLUMN "requires",
DROP COLUMN "blocks";
