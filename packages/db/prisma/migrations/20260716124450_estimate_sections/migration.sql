-- DropForeignKey
ALTER TABLE "RoleLineItem" DROP CONSTRAINT "RoleLineItem_menuItemId_fkey";

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sectionId" TEXT;

-- CreateTable
CREATE TABLE "EstimateSection" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimateSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EstimateSection_estimateId_idx" ON "EstimateSection"("estimateId");

-- CreateIndex
CREATE INDEX "MenuItem_sectionId_idx" ON "MenuItem"("sectionId");

-- AddForeignKey
ALTER TABLE "EstimateSection" ADD CONSTRAINT "EstimateSection_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "EstimateSection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleLineItem" ADD CONSTRAINT "RoleLineItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
