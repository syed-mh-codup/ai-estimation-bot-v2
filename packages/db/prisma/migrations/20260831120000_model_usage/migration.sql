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
    'EMBEDDING'
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

-- Oracle's per-turn cost moves to ModelUsage so the report and the transcript
-- read the same source. The four columns below are no longer the cost surface.
ALTER TABLE "OracleMessage" DROP COLUMN "modelString";
ALTER TABLE "OracleMessage" DROP COLUMN "promptTokens";
ALTER TABLE "OracleMessage" DROP COLUMN "completionTokens";
ALTER TABLE "OracleMessage" DROP COLUMN "costUsd";
