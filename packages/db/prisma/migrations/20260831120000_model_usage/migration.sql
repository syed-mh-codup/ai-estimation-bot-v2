-- AEH-286: model-usage audit. One table is the single home for all AI spend, and
-- every model call — the run crew, Oracle, ingestion and embedding — records what
-- it actually cost there.
--
-- Costing outlives the estimate: every FK that names a derived object is SET
-- NULL, not CASCADE, because a spend record answers "what did this cost to
-- produce" even after the estimate, thread or message that prompted it is gone.
CREATE TYPE "UsageKind" AS ENUM (
    'SUPERVISOR',
    'LIBRARIAN',
    'DETECTIVE',
    'ARCHIVIST',
    'SPECIALIST_DEV',
    'SPECIALIST_QA',
    'SPECIALIST_PM',
    'SPECIALIST_BA',
    'ARCHITECT',
    'ORACLE',
    'INGEST',
    'PRESET_EMBEDDING'
);

CREATE TABLE "ModelUsage" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT,
    "runId" TEXT,
    "kind" "UsageKind" NOT NULL,
    "model" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "oracleMessageId" TEXT,
    "threadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ModelUsage_estimateId_createdAt_idx" ON "ModelUsage"("estimateId", "createdAt");
CREATE INDEX "ModelUsage_kind_idx" ON "ModelUsage"("kind");
CREATE INDEX "ModelUsage_runId_idx" ON "ModelUsage"("runId");
CREATE INDEX "ModelUsage_threadId_idx" ON "ModelUsage"("threadId");
CREATE UNIQUE INDEX "ModelUsage_oracleMessageId_key" ON "ModelUsage"("oracleMessageId");

ALTER TABLE "ModelUsage" ADD CONSTRAINT "ModelUsage_estimateId_fkey"
    FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ModelUsage" ADD CONSTRAINT "ModelUsage_oracleMessageId_fkey"
    FOREIGN KEY ("oracleMessageId") REFERENCES "OracleMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ModelUsage" ADD CONSTRAINT "ModelUsage_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "OracleThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Data migration: carry Oracle's existing per-turn cost onto ModelUsage ────
-- Oracle's per-turn cost MOVES to ModelUsage — it is not discarded. Every
-- assistant turn that recorded anything becomes a ModelUsage row before the
-- columns holding it are dropped, so the spend history AEH-259 accumulated
-- survives into the report that now owns it.
--
-- `createdAt` is carried from the message rather than defaulted to now(), or
-- every historical turn would collapse onto the deploy date and the "is spend
-- trending up" question would be unanswerable for everything before today.
--
-- Turns where all four columns are null are skipped: there is no cost fact to
-- record, and an all-null row would read as a priced call that cost nothing.
INSERT INTO "ModelUsage" (
  "id", "estimateId", "runId", "kind", "model",
  "promptTokens", "completionTokens", "costUsd",
  "oracleMessageId", "threadId", "createdAt"
)
SELECT
  gen_random_uuid()::text,
  t."estimateId",
  NULL,                      -- Oracle answers are not part of a run.
  'ORACLE'::"UsageKind",
  m."modelString",
  m."promptTokens",
  m."completionTokens",
  m."costUsd",
  m."id",
  m."threadId",
  m."createdAt"
FROM "OracleMessage" m
JOIN "OracleThread" t ON t."id" = m."threadId"
WHERE m."role" = 'ASSISTANT'
  AND (
    m."modelString" IS NOT NULL
    OR m."promptTokens" IS NOT NULL
    OR m."completionTokens" IS NOT NULL
    OR m."costUsd" IS NOT NULL
  );

-- The four columns are no longer the cost surface; their data now lives above.
ALTER TABLE "OracleMessage" DROP COLUMN "modelString";
ALTER TABLE "OracleMessage" DROP COLUMN "promptTokens";
ALTER TABLE "OracleMessage" DROP COLUMN "completionTokens";
ALTER TABLE "OracleMessage" DROP COLUMN "costUsd";
