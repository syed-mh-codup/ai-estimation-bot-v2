-- CreateTable
CREATE TABLE "SheetExport" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "exportedById" TEXT,
    "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sheetModifiedAt" TIMESTAMP(3),

    CONSTRAINT "SheetExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SheetExport_estimateId_exportedAt_idx" ON "SheetExport"("estimateId", "exportedAt");

-- AddForeignKey
ALTER TABLE "SheetExport" ADD CONSTRAINT "SheetExport_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SheetExport" ADD CONSTRAINT "SheetExport_exportedById_fkey" FOREIGN KEY ("exportedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

