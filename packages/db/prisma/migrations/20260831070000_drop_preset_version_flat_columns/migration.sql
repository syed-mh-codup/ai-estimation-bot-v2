-- AEH-244: Drop the flat columns from PresetVersion now that the concerns have
-- been moved to PresetRetrieval (retrieval surface), PresetAnchor (estimate
-- anchor) and PresetComposition (composition rules).

ALTER TABLE "PresetVersion" DROP COLUMN "category";
ALTER TABLE "PresetVersion" DROP COLUMN "name";
ALTER TABLE "PresetVersion" DROP COLUMN "description";
ALTER TABLE "PresetVersion" DROP COLUMN "devHours";
ALTER TABLE "PresetVersion" DROP COLUMN "touchesFrontend";
ALTER TABLE "PresetVersion" DROP COLUMN "touchesBackend";
ALTER TABLE "PresetVersion" DROP COLUMN "beHours";
ALTER TABLE "PresetVersion" DROP COLUMN "feHours";
ALTER TABLE "PresetVersion" DROP COLUMN "platforms";
ALTER TABLE "PresetVersion" DROP COLUMN "reqType";
ALTER TABLE "PresetVersion" DROP COLUMN "keywords";
ALTER TABLE "PresetVersion" DROP COLUMN "userStoryTags";
ALTER TABLE "PresetVersion" DROP COLUMN "projectSizeFit";
ALTER TABLE "PresetVersion" DROP COLUMN "integrationCount";
ALTER TABLE "PresetVersion" DROP COLUMN "dataVolume";
ALTER TABLE "PresetVersion" DROP COLUMN "phase";
ALTER TABLE "PresetVersion" DROP COLUMN "requires";
ALTER TABLE "PresetVersion" DROP COLUMN "blocks";
ALTER TABLE "PresetVersion" DROP COLUMN "canParallel";
ALTER TABLE "PresetVersion" DROP COLUMN "aiAssist";
ALTER TABLE "PresetVersion" DROP COLUMN "risk";
ALTER TABLE "PresetVersion" DROP COLUMN "spikeNeeded";
ALTER TABLE "PresetVersion" DROP COLUMN "notes";
ALTER TABLE "PresetVersion" DROP COLUMN "taxonomyKey";
ALTER TABLE "PresetVersion" DROP COLUMN "embedding";
ALTER TABLE "PresetVersion" DROP COLUMN "embeddingText";
