-- CreateEnum
CREATE TYPE "DependencySource" AS ENUM ('INFERRED', 'PRESET', 'MANUAL');

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "foundation" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MenuItemDependency" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "dependentId" TEXT NOT NULL,
    "prerequisiteId" TEXT NOT NULL,
    "note" TEXT,
    "source" "DependencySource" NOT NULL DEFAULT 'INFERRED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MenuItemDependency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MenuItemDependency_estimateId_idx" ON "MenuItemDependency"("estimateId");

-- CreateIndex
CREATE INDEX "MenuItemDependency_prerequisiteId_idx" ON "MenuItemDependency"("prerequisiteId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemDependency_dependentId_prerequisiteId_key" ON "MenuItemDependency"("dependentId", "prerequisiteId");

-- CreateIndex
CREATE INDEX "MenuItem_estimateId_idx" ON "MenuItem"("estimateId");

-- AddForeignKey
ALTER TABLE "MenuItemDependency" ADD CONSTRAINT "MenuItemDependency_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemDependency" ADD CONSTRAINT "MenuItemDependency_dependentId_fkey" FOREIGN KEY ("dependentId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemDependency" ADD CONSTRAINT "MenuItemDependency_prerequisiteId_fkey" FOREIGN KEY ("prerequisiteId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A card cannot depend on itself. PresetDependency documents that SQL could not
-- express this invariant, because its two ends live in different tables and a
-- CHECK cannot see both. Here both ends are MenuItem columns on one row, so the
-- database can enforce it and the code does not have to be trusted with it.
-- The no-cycle invariant is still code-only: no CHECK can walk a graph.
ALTER TABLE "MenuItemDependency"
  ADD CONSTRAINT "MenuItemDependency_no_self_edge"
  CHECK ("dependentId" <> "prerequisiteId");
