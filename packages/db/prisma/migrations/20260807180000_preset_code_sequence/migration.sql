-- Readable, auto-allocated preset codes + recorded provenance.
--
-- Codes are "P" + a number from a Postgres SEQUENCE. A sequence rather than
-- max(code)+1 because allocation is concurrent: two estimates finalising at the
-- same moment would both read the same max and race — one hitting the unique
-- constraint, or (without it) two presets silently sharing a code. nextval is
-- atomic and needs no locking.
--
-- Numbers are free-flowing: no zero padding, no fixed width. Codes imported
-- from the xlsx keep that file's own formatting (P01–P45) since people
-- cross-reference the spreadsheet; allocated codes are plain (P46, P100).

CREATE TYPE "PresetOrigin" AS ENUM ('SEEDED', 'FINALISED', 'MANUAL');

ALTER TABLE "Preset" ADD COLUMN "origin" "PresetOrigin" NOT NULL DEFAULT 'MANUAL';

-- Everything in the library today came from the xlsx import. Unambiguous:
-- verified 0 rows with sourceEstimateId before writing this.
UPDATE "Preset" SET "origin" = 'SEEDED' WHERE "code" IS NOT NULL;

-- Idempotency key for promotion (see schema comment).
ALTER TABLE "PresetVersion" ADD COLUMN "sourceMenuItemId" TEXT;

-- Start after the highest number already in use, so an allocated code can never
-- collide with an imported one. COALESCE covers a library seeded from scratch.
CREATE SEQUENCE "preset_code_seq" AS BIGINT MINVALUE 1;
SELECT setval(
  'preset_code_seq',
  COALESCE((SELECT max(NULLIF(regexp_replace(code, '\D', '', 'g'), '')::bigint) FROM "Preset"), 0) + 1,
  false
);
