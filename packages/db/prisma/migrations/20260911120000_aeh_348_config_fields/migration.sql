-- ─── AEH-348: complexityRules / infraBaseline Json → columns and rows ────────
--
-- Both settings were edited as raw JSON in a textarea on /admin/config, and the
-- complexity blob is parsed with `ComplexityRulesSchema.parse`, which THROWS —
-- so a mistyped brace there did not fail on save, it failed the next estimate
-- run, on a screen nobody was watching.
--
-- Order is the whole design of this file: each new column is added carrying the
-- shipped DEFAULT so existing rows are legal the instant it exists, then
-- backfilled from the blob. The blobs are dropped last, after everything has
-- been read out of them.
--
-- Where a blob never held a key — `{}` is what e2e's global setup writes — the
-- row takes the shipped default rather than a zero. A 0 multiplier would flatten
-- every complexity score it touched, and a migration must not invent a pricing
-- change. Numbers are read through `->>`, which yields text for both `3` and
-- `"3"`, so only genuinely non-numeric junk aborts — and an abort rolls the
-- whole migration back, which is the safe direction to fail in.

-- CreateTable
CREATE TABLE "ComplexityApiThreshold" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "minCount" INTEGER NOT NULL,
    "maxCount" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "ComplexityApiThreshold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessOverheadItem" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "taxonomyKey" TEXT NOT NULL,
    "devPct" DOUBLE PRECISION,
    "qaPct" DOUBLE PRECISION,
    "pmPct" DOUBLE PRECISION,
    "baPct" DOUBLE PRECISION,

    CONSTRAINT "ProcessOverheadItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ComplexityApiThreshold_configId_position_key" ON "ComplexityApiThreshold"("configId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessOverheadItem_configId_position_key" ON "ProcessOverheadItem"("configId", "position");

-- AddForeignKey
ALTER TABLE "ComplexityApiThreshold" ADD CONSTRAINT "ComplexityApiThreshold_configId_fkey" FOREIGN KEY ("configId") REFERENCES "EstimationConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessOverheadItem" ADD CONSTRAINT "ProcessOverheadItem_configId_fkey" FOREIGN KEY ("configId") REFERENCES "EstimationConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "EstimationConfig"
    ADD COLUMN "legacyKeywords" TEXT[],
    ADD COLUMN "legacyScoreBonus" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    ADD COLUMN "aiKeywords" TEXT[],
    ADD COLUMN "aiScoreBonus" DOUBLE PRECISION NOT NULL DEFAULT 1.3,
    ADD COLUMN "dataVolumeMultiplierNone" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    ADD COLUMN "dataVolumeMultiplierLow" DOUBLE PRECISION NOT NULL DEFAULT 1.1,
    ADD COLUMN "dataVolumeMultiplierHigh" DOUBLE PRECISION NOT NULL DEFAULT 1.5;

-- ─── Data migration: read the blobs out into columns ─────────────────────────

UPDATE "EstimationConfig" SET
    "legacyKeywords" = CASE
        WHEN jsonb_typeof("complexityRules" -> 'legacyKeywords') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text("complexityRules" -> 'legacyKeywords'))
        ELSE ARRAY[]::TEXT[]
    END,
    "aiKeywords" = CASE
        WHEN jsonb_typeof("complexityRules" -> 'aiKeywords') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text("complexityRules" -> 'aiKeywords'))
        ELSE ARRAY[]::TEXT[]
    END,
    "legacyScoreBonus" = COALESCE(("complexityRules" ->> 'legacyScoreBonus')::DOUBLE PRECISION, 1.5),
    "aiScoreBonus" = COALESCE(("complexityRules" ->> 'aiScoreBonus')::DOUBLE PRECISION, 1.3),
    "dataVolumeMultiplierNone" = COALESCE(("complexityRules" -> 'dataVolumeMultipliers' ->> 'NONE')::DOUBLE PRECISION, 1.0),
    "dataVolumeMultiplierLow" = COALESCE(("complexityRules" -> 'dataVolumeMultipliers' ->> 'LOW')::DOUBLE PRECISION, 1.1),
    "dataVolumeMultiplierHigh" = COALESCE(("complexityRules" -> 'dataVolumeMultipliers' ->> 'HIGH')::DOUBLE PRECISION, 1.5);

-- One row per threshold, ordinality preserved: the engine takes the first band
-- that contains the integration count and stops, so the order the admin wrote
-- them in IS the rule.
INSERT INTO "ComplexityApiThreshold" ("id", "configId", "position", "minCount", "maxCount", "score")
SELECT
    gen_random_uuid()::text,
    c."id",
    (t.ord - 1)::INTEGER,
    COALESCE((t.value ->> 'minCount')::NUMERIC::INTEGER, 0),
    COALESCE((t.value ->> 'maxCount')::NUMERIC::INTEGER, 0),
    COALESCE((t.value ->> 'score')::DOUBLE PRECISION, 1)
FROM "EstimationConfig" c
CROSS JOIN LATERAL jsonb_array_elements(
    CASE
        WHEN jsonb_typeof(c."complexityRules" -> 'apiIntegrationThresholds') = 'array'
        THEN c."complexityRules" -> 'apiIntegrationThresholds'
        ELSE '[]'::JSONB
    END
) WITH ORDINALITY AS t(value, ord);

-- One row per overhead item. A role absent from `pct` charged that role nothing,
-- which is now a NULL column rather than a missing key — the same statement,
-- said in a way a form field can show and a reader can scan.
INSERT INTO "ProcessOverheadItem" ("id", "configId", "position", "title", "taxonomyKey", "devPct", "qaPct", "pmPct", "baPct")
SELECT
    gen_random_uuid()::text,
    c."id",
    (i.ord - 1)::INTEGER,
    COALESCE(i.value ->> 'title', 'Untitled'),
    COALESCE(i.value ->> 'taxonomyKey', ''),
    (i.value -> 'pct' ->> 'DEV')::DOUBLE PRECISION,
    (i.value -> 'pct' ->> 'QA')::DOUBLE PRECISION,
    (i.value -> 'pct' ->> 'PM')::DOUBLE PRECISION,
    (i.value -> 'pct' ->> 'BA')::DOUBLE PRECISION
FROM "EstimationConfig" c
CROSS JOIN LATERAL jsonb_array_elements(
    CASE
        WHEN jsonb_typeof(c."infraBaseline" -> 'items') = 'array'
        THEN c."infraBaseline" -> 'items'
        ELSE '[]'::JSONB
    END
) WITH ORDINALITY AS i(value, ord);

-- The defaults added above are kept, not dropped: the Prisma schema declares
-- the same five, so that a config row is complete and scoreable by construction
-- rather than only when every writer remembered all of it.

-- DropColumn — last, once every value has been read out.
ALTER TABLE "EstimationConfig"
    DROP COLUMN "complexityRules",
    DROP COLUMN "infraBaseline";
