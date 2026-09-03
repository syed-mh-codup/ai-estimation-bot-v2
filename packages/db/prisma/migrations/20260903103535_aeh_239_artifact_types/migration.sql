-- AlterEnum
ALTER TYPE "UsageKind" ADD VALUE 'ARTIFACT';

-- AlterTable
ALTER TABLE "ModelUsage" ADD COLUMN     "artifactId" TEXT;

-- CreateTable
CREATE TABLE "ArtifactType" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtifactType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtifactTypeVersion" (
    "id" TEXT NOT NULL,
    "artifactTypeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "promptBody" TEXT NOT NULL,
    "modelString" TEXT NOT NULL,
    "corpusSections" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT false,
    "changeReason" TEXT,
    "changeMotivation" "ChangeMotivation" NOT NULL DEFAULT 'OTHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "ArtifactTypeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateArtifact" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "artifactTypeId" TEXT NOT NULL,
    "typeVersion" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "outline" JSONB,
    "content" TEXT,
    "inputs" JSONB,
    "status" "RunStatus" NOT NULL DEFAULT 'IDLE',
    "stage" TEXT,
    "pct" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimateArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtifactSection" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtifactSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactType_key_key" ON "ArtifactType"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactTypeVersion_artifactTypeId_version_key" ON "ArtifactTypeVersion"("artifactTypeId", "version");

-- CreateIndex
CREATE INDEX "EstimateArtifact_estimateId_createdAt_idx" ON "EstimateArtifact"("estimateId", "createdAt");

-- CreateIndex
CREATE INDEX "EstimateArtifact_artifactTypeId_idx" ON "EstimateArtifact"("artifactTypeId");

-- CreateIndex
CREATE INDEX "ArtifactSection_artifactId_order_idx" ON "ArtifactSection"("artifactId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactSection_artifactId_sectionId_key" ON "ArtifactSection"("artifactId", "sectionId");

-- CreateIndex
CREATE INDEX "ModelUsage_artifactId_idx" ON "ModelUsage"("artifactId");

-- AddForeignKey
ALTER TABLE "ModelUsage" ADD CONSTRAINT "ModelUsage_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "EstimateArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactTypeVersion" ADD CONSTRAINT "ArtifactTypeVersion_artifactTypeId_fkey" FOREIGN KEY ("artifactTypeId") REFERENCES "ArtifactType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateArtifact" ADD CONSTRAINT "EstimateArtifact_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateArtifact" ADD CONSTRAINT "EstimateArtifact_artifactTypeId_fkey" FOREIGN KEY ("artifactTypeId") REFERENCES "ArtifactType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactSection" ADD CONSTRAINT "ArtifactSection_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "EstimateArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
