-- CreateTable
CREATE TABLE "PresetRetrieval" (
    "id" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "keywords" TEXT[],
    "embeddingText" TEXT,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PresetRetrieval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PresetAnchor" (
    "id" TEXT NOT NULL,
    "presetVersionId" TEXT NOT NULL,
    "devHours" INTEGER NOT NULL,
    "touchesFrontend" BOOLEAN NOT NULL DEFAULT false,
    "touchesBackend" BOOLEAN NOT NULL DEFAULT false,
    "beHours" INTEGER,
    "feHours" INTEGER,
    "risk" "Level" NOT NULL,
    "aiAssist" "Level" NOT NULL,
    "dataVolume" "DataVolume" NOT NULL,
    "integrationCount" INTEGER NOT NULL,
    "projectSizeFit" TEXT[],
    "phase" "PresetPhase" NOT NULL,
    "spikeNeeded" BOOLEAN NOT NULL,
    "notes" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "reqType" TEXT NOT NULL,
    "platforms" TEXT[],
    "userStoryTags" TEXT[],
    "taxonomyKey" TEXT,

    CONSTRAINT "PresetAnchor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PresetComposition" (
    "id" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "requires" TEXT[],
    "blocks" TEXT[],
    "canParallel" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PresetComposition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PresetRetrieval_presetId_key" ON "PresetRetrieval"("presetId");

-- CreateIndex
CREATE UNIQUE INDEX "PresetAnchor_presetVersionId_key" ON "PresetAnchor"("presetVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "PresetComposition_presetId_key" ON "PresetComposition"("presetId");

-- AddForeignKey
ALTER TABLE "PresetRetrieval" ADD CONSTRAINT "PresetRetrieval_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "Preset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresetAnchor" ADD CONSTRAINT "PresetAnchor_presetVersionId_fkey" FOREIGN KEY ("presetVersionId") REFERENCES "PresetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresetComposition" ADD CONSTRAINT "PresetComposition_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "Preset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Data migration: populate the new tables from existing PresetVersion rows ───
-- Retrieval: one row per preset, from its active (or latest) version.
INSERT INTO "PresetRetrieval" ("id", "presetId", "name", "description", "keywords", "embeddingText", "embedding", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  v."presetId",
  v."name",
  v."description",
  v."keywords",
  v."embeddingText",
  v."embedding",
  v."createdAt",
  v."createdAt"
FROM "PresetVersion" v
JOIN (
  SELECT "presetId", MAX(version) AS max_version
  FROM "PresetVersion"
  GROUP BY "presetId"
) latest ON latest."presetId" = v."presetId" AND latest.max_version = v."version";

-- Anchor: one row per PresetVersion.
INSERT INTO "PresetAnchor" ("id", "presetVersionId", "devHours", "touchesFrontend", "touchesBackend", "beHours", "feHours", "risk", "aiAssist", "dataVolume", "integrationCount", "projectSizeFit", "phase", "spikeNeeded", "notes", "category", "reqType", "platforms", "userStoryTags", "taxonomyKey")
SELECT
  gen_random_uuid()::text,
  v."id",
  v."devHours",
  v."touchesFrontend",
  v."touchesBackend",
  v."beHours",
  v."feHours",
  v."risk",
  v."aiAssist",
  v."dataVolume",
  v."integrationCount",
  v."projectSizeFit",
  v."phase",
  v."spikeNeeded",
  v."notes",
  v."category",
  v."reqType",
  v."platforms",
  v."userStoryTags",
  v."taxonomyKey"
FROM "PresetVersion" v;

-- Composition: one row per preset, from its active (or latest) version.
INSERT INTO "PresetComposition" ("id", "presetId", "requires", "blocks", "canParallel", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  v."presetId",
  v."requires",
  v."blocks",
  v."canParallel",
  v."createdAt",
  v."createdAt"
FROM "PresetVersion" v
JOIN (
  SELECT "presetId", MAX(version) AS max_version
  FROM "PresetVersion"
  GROUP BY "presetId"
) latest ON latest."presetId" = v."presetId" AND latest.max_version = v."version";
