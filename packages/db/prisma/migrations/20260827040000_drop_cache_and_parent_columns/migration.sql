-- AEH-253: drop columns whose only readers were deleted with the code that read them.
--
-- The four Estimate columns existed for runSupervisor's two-tier cache
-- (packages/agents/src/cache.ts). runSupervisor was superseded by runEstimate,
-- which never cached, so the cache layer and its key inputs go together.
-- "sowHash" is a recomputable hash; the three Json columns held '{}' in every
-- writer the repo has ever had, because taxonomy/prompt version pinning was
-- specified and never implemented. "configVersion" is deliberately NOT dropped:
-- the estimate header renders it.
--
-- MenuItem."parentItemId" was written by nothing (0 of 77 rows on dev) and read
-- only by getAffectedChildren, a zero-caller export deleted in the same commit.

DROP INDEX IF EXISTS "Estimate_sowHash_idx";

ALTER TABLE "Estimate"
  DROP COLUMN IF EXISTS "sowHash",
  DROP COLUMN IF EXISTS "taxonomyVersionsPinned",
  DROP COLUMN IF EXISTS "promptVersionsPinned",
  DROP COLUMN IF EXISTS "modelConfig";

ALTER TABLE "MenuItem"
  DROP COLUMN IF EXISTS "parentItemId";
