-- Drop DependencySource.PRESET.
--
-- It encoded a design that was rejected: propagating the preset library's
-- dependency edges into a new estimate as suggestions. Every project is
-- different, so one project's ordering is not evidence about another's — the
-- library's graph is a record of past work, read for library-side views and
-- never fed back into an estimate. An edge on an estimate is therefore either
-- worked out for that scope (INFERRED) or typed by a person (MANUAL).
--
-- Postgres cannot remove a value from an enum in place, so the type is rebuilt.
-- Safe as a plain swap because no row has ever carried the value: the column
-- was introduced days ago and only INFERRED and MANUAL are written. Verified
-- zero rows on all four databases immediately before applying.
ALTER TYPE "DependencySource" RENAME TO "DependencySource_old";

CREATE TYPE "DependencySource" AS ENUM ('INFERRED', 'MANUAL');

ALTER TABLE "MenuItemDependency"
  ALTER COLUMN "source" DROP DEFAULT,
  ALTER COLUMN "source" TYPE "DependencySource"
    USING ("source"::text::"DependencySource"),
  ALTER COLUMN "source" SET DEFAULT 'INFERRED';

DROP TYPE "DependencySource_old";
