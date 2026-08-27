-- AEH-263: governance state for taxonomy nodes.
--
-- The taxonomy had no authoring surface at all: every node was derived wholesale
-- from the preset library by seed-taxonomy.ts as `${slug(category)}.${slug(reqType)}`.
-- Shipping the hidden-work feature means nodes can now be PROPOSED by a run, so
-- "is this node real yet" has to be a queryable fact rather than a convention.
--
-- `status` is what bounds the blast radius: loadTaxonomyEntries filters on it, and
-- that query is the Librarian's entire classification vocabulary. A PROPOSED node
-- therefore changes no estimate until an admin accepts it.
--
-- Additive and non-destructive. Every existing node is derived from a real preset
-- and is already live in the Librarian's vocabulary, so ACTIVE is the correct
-- default for all of them and there is nothing to backfill.
CREATE TYPE "TaxonomyStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'COLLAPSED');

ALTER TABLE "TaxonomyNode" ADD COLUMN "status" "TaxonomyStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "TaxonomyNode" ADD COLUMN "collapsedIntoKey" TEXT;
