-- The exact text an embedding was generated from, so staleness is decidable.
--
-- Deliberately left NULL for existing rows rather than guessed at: the 45
-- seeded presets were embedded by a one-off routine that no longer exists in
-- the repo, so we cannot honestly claim to know their source text. NULL means
-- "unknown provenance", which the backfill treats as stale and regenerates
-- once — cheap, and it puts every row under tracking from then on.
ALTER TABLE "PresetVersion" ADD COLUMN "embeddingText" TEXT;
