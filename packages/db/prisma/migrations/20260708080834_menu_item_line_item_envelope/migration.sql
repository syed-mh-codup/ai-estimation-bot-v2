-- DropIndex
DROP INDEX "RoleLineItem_menuItemId_role_key";

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "category" TEXT,
ADD COLUMN     "meta" JSONB,
ADD COLUMN     "phase" TEXT;

-- AlterTable
ALTER TABLE "RoleLineItem" ADD COLUMN     "meta" JSONB,
ADD COLUMN     "title" TEXT;

-- CreateIndex
CREATE INDEX "RoleLineItem_menuItemId_role_idx" ON "RoleLineItem"("menuItemId", "role");
