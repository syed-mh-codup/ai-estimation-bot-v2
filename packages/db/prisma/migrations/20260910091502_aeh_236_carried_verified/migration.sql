-- AlterTable
ALTER TABLE "EstimateStatement" ADD COLUMN     "carriedVerified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RoleLineItem" ADD COLUMN     "carriedVerified" BOOLEAN NOT NULL DEFAULT false;
