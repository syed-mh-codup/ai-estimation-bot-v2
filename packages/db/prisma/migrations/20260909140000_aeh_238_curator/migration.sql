-- AEH-238: the Curator — the agent that decides what belongs on a card.
--
-- Its own kind rather than reuse, and the reason is what it does NOT do: it
-- never prices anything. It decides which cards should exist and which existing
-- lines belong to each; the specialist council re-prices the result afterwards.
-- The Architect assembles cards from a whole run's specialist output, which is a
-- different job with a different input.
--
-- Two enums, because an agent-shaped UsageKind is literally the AgentKind
-- string — see packages/db/src/usage-catalogue.ts, whose completeness test fails
-- if these two ever disagree about the shape of the vocabulary.

-- AlterEnum
ALTER TYPE "AgentKind" ADD VALUE 'CURATOR';

-- AlterEnum
ALTER TYPE "UsageKind" ADD VALUE 'CURATOR';
