-- DropForeignKey
ALTER TABLE "MenuItem" DROP CONSTRAINT "MenuItem_estimateId_fkey";

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
