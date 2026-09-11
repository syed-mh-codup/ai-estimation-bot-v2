-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT;

-- CreateIndex
CREATE INDEX "Estimate_deletedAt_idx" ON "Estimate"("deletedAt");

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
