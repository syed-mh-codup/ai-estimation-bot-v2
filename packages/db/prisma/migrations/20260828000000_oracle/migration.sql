-- AEH-259: Oracle -- chat with an estimate's source material.
--
-- Oracle reads one estimate's whole corpus and answers questions about it. It
-- has no write path to any estimate, so nothing here touches an existing table
-- beyond adding the enum value its prompt is keyed on.
--
-- ORACLE joins AgentKind rather than becoming some new "assistant" concept
-- because it IS an agent: it has a versioned, admin-editable system prompt and a
-- model string, resolved through the same PromptVersion machinery as the run
-- crew. This is the first ALTER TYPE ... ADD VALUE in this repo. It is legal
-- inside the transaction Prisma wraps a migration in, on PG12+, precisely
-- because nothing below USES the new value -- creating a table whose column is
-- of that enum's type is fine, inserting the value would not be. Seeding the
-- ORACLE prompt row is therefore a separate, targeted script and NOT part of
-- this migration (and NOT the bootstrap seed, which force-reverts every live
-- prompt to its v1 body).
ALTER TYPE "AgentKind" ADD VALUE IF NOT EXISTS 'ORACLE';

-- Two roles is the whole vocabulary: the system prompt is the live PromptVersion
-- rather than a stored turn, and Oracle has no tools.
CREATE TYPE "OracleRole" AS ENUM ('USER', 'ASSISTANT');

-- A thread is one line of enquiry by one person about one estimate.
--
-- Threads are user-created and many-per-estimate so separate questions stay
-- separate and each thread's replayed context stays bounded. Cascade on BOTH
-- foreign keys: deleting an estimate takes its threads, and so does deleting a
-- user -- a thread is one person's investigation and means nothing detached
-- from them. Note this is the first user-scoped READ rule in the schema; every
-- other table here is a shared workspace.
CREATE TABLE "OracleThread" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OracleThread_pkey" PRIMARY KEY ("id")
);

-- One turn.
--
-- citations holds the spans the answer quoted, as emitted. Whether a span is
-- still present in the corpus is deliberately NOT stored: it is recomputed on
-- read, because a stored verdict goes stale the moment the source is edited,
-- and the live check is the only thing that can tell a FABRICATED quote (absent
-- while sowHash still matches) from a merely STALE one (absent because the hash
-- moved). That distinction is the point of the feature.
--
-- sowHash exists here rather than on Estimate because Estimate.sowHash was
-- dropped in AEH-253 along with the cache layer that was its only reader.
--
-- The usage columns are nullable because they only apply to assistant turns,
-- and because a provider is not obliged to report them. costUsd is recorded as
-- reported rather than derived from tokens: converting tokens to money needs a
-- price table that changes underneath old rows.
CREATE TABLE "OracleMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" "OracleRole" NOT NULL,
    "content" TEXT NOT NULL,
    "citations" TEXT[],
    "sowHash" TEXT NOT NULL,
    "estimateRunAt" TIMESTAMP(3),
    "modelString" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OracleMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OracleThread_estimateId_userId_idx" ON "OracleThread"("estimateId", "userId");
CREATE INDEX "OracleMessage_threadId_createdAt_idx" ON "OracleMessage"("threadId", "createdAt");

ALTER TABLE "OracleThread" ADD CONSTRAINT "OracleThread_estimateId_fkey"
    FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OracleThread" ADD CONSTRAINT "OracleThread_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OracleMessage" ADD CONSTRAINT "OracleMessage_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "OracleThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
