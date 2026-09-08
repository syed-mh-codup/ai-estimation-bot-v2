-- Source document order, so the sequence the model reads them in is chosen
-- rather than incidental.
--
-- Additive with a default, so existing rows are valid immediately. Backfilling
-- from createdAt is deliberately NOT attempted: UploadedFile rows are deleted
-- the moment an ingest finishes, so any row present when this runs belongs to
-- an ingest that is still in flight or has failed, and 0 for all of them
-- reproduces exactly the unordered read those rows already had.

-- AlterTable
ALTER TABLE "UploadedFile" ADD COLUMN     "order" INTEGER NOT NULL DEFAULT 0;
