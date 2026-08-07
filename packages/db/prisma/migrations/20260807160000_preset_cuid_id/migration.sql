-- Presets get generated ids, so nothing has to allocate a preset number. The
-- creation UI must not ask an operator to pick "the next one" — in a shared
-- library there is no safe way for them to know it.
--
-- `code` carries the xlsx import number as provenance/display instead of
-- identity. The seeded 45 keep their existing ids on purpose: those strings are
-- referenced by the requires/blocks dependency graph between presets, by
-- existing MenuItem.sourcePresetId rows, and by six live agent prompts that
-- name the P01–P45 range. Remapping them would require rewriting all three in
-- lockstep, which is a separate decision.
ALTER TABLE "Preset" ADD COLUMN "code" TEXT;

-- Backfill: everything imported so far was keyed by its xlsx code.
UPDATE "Preset" SET "code" = id WHERE id ~ '^P[0-9]+$';

CREATE UNIQUE INDEX "Preset_code_key" ON "Preset"("code");
