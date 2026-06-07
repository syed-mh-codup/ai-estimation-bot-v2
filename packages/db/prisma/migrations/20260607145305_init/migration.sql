-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'ESTIMATOR');

-- CreateEnum
CREATE TYPE "ChangeMotivation" AS ENUM ('UPSKILL', 'TECH_ADVANCEMENT', 'NEW_PROCESS', 'POST_DELIVERY_VALIDATION', 'CORRECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "DataVolume" AS ENUM ('NONE', 'LOW', 'HIGH');

-- CreateEnum
CREATE TYPE "PresetPhase" AS ENUM ('FOUNDATION', 'CORE', 'ENHANCEMENT');

-- CreateEnum
CREATE TYPE "Level" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "AgentKind" AS ENUM ('SUPERVISOR', 'LIBRARIAN', 'DETECTIVE', 'ARCHIVIST', 'SPECIALIST_DEV', 'SPECIALIST_QA', 'SPECIALIST_PM', 'SPECIALIST_BA', 'ARCHITECT');

-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('DRAFT', 'REVIEW', 'FINALISED');

-- CreateEnum
CREATE TYPE "RoleKind" AS ENUM ('DEV', 'QA', 'PM', 'BA');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "name" TEXT,
    "role" "Role" NOT NULL DEFAULT 'ESTIMATOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxonomyNode" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "parentKey" TEXT,

    CONSTRAINT "TaxonomyNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxonomyNodeVersion" (
    "id" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "reqType" TEXT,
    "keywords" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT false,
    "changeReason" TEXT,
    "changeMotivation" "ChangeMotivation" NOT NULL DEFAULT 'OTHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "TaxonomyNodeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Preset" (
    "id" TEXT NOT NULL,

    CONSTRAINT "Preset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PresetVersion" (
    "id" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "beHours" INTEGER NOT NULL,
    "feHours" INTEGER NOT NULL,
    "platforms" TEXT[],
    "reqType" TEXT NOT NULL,
    "keywords" TEXT[],
    "userStoryTags" TEXT[],
    "projectSizeFit" TEXT[],
    "integrationCount" INTEGER NOT NULL,
    "dataVolume" "DataVolume" NOT NULL,
    "phase" "PresetPhase" NOT NULL,
    "requires" TEXT[],
    "blocks" TEXT[],
    "canParallel" BOOLEAN NOT NULL,
    "aiAssist" "Level" NOT NULL,
    "risk" "Level" NOT NULL,
    "spikeNeeded" BOOLEAN NOT NULL,
    "notes" TEXT NOT NULL,
    "taxonomyKey" TEXT,
    "embedding" vector(1536),
    "changeReason" TEXT,
    "changeMotivation" "ChangeMotivation" NOT NULL DEFAULT 'OTHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "sourceEstimateId" TEXT,

    CONSTRAINT "PresetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prompt" (
    "kind" "AgentKind" NOT NULL,

    CONSTRAINT "Prompt_pkey" PRIMARY KEY ("kind")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "kind" "AgentKind" NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "modelString" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "changeReason" TEXT,
    "changeMotivation" "ChangeMotivation" NOT NULL DEFAULT 'OTHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimationConfig" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "complexityRules" JSONB NOT NULL,
    "pmCommunicationTaxPct" DOUBLE PRECISION NOT NULL,
    "baCommunicationTaxPct" DOUBLE PRECISION NOT NULL,
    "qaRegressionBufferPct" DOUBLE PRECISION NOT NULL,
    "infraBaseline" JSONB NOT NULL,
    "changeReason" TEXT,
    "changeMotivation" "ChangeMotivation" NOT NULL DEFAULT 'OTHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpConnector" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "authRef" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastTestOk" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpConnector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Estimate" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sowText" TEXT NOT NULL,
    "sowHash" TEXT NOT NULL,
    "status" "EstimateStatus" NOT NULL DEFAULT 'DRAFT',
    "complexityScore" INTEGER,
    "taxonomyVersionsPinned" JSONB NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "promptVersionsPinned" JSONB NOT NULL,
    "modelConfig" JSONB NOT NULL,
    "narrative" TEXT[],
    "assumptions" TEXT[],
    "agentState" JSONB NOT NULL,
    "ownerId" TEXT NOT NULL,
    "sheetUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Estimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "taxonomyKey" TEXT NOT NULL,
    "sourcePresetId" TEXT,
    "matchScore" DOUBLE PRECISION,
    "title" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "parentItemId" TEXT,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleLineItem" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "role" "RoleKind" NOT NULL,
    "baseHours" DOUBLE PRECISION NOT NULL,
    "taxedHours" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "edited" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RoleLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "TaxonomyNode_key_key" ON "TaxonomyNode"("key");

-- CreateIndex
CREATE UNIQUE INDEX "TaxonomyNodeVersion_nodeKey_version_key" ON "TaxonomyNodeVersion"("nodeKey", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PresetVersion_presetId_version_key" ON "PresetVersion"("presetId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_kind_version_key" ON "PromptVersion"("kind", "version");

-- CreateIndex
CREATE UNIQUE INDEX "EstimationConfig_version_key" ON "EstimationConfig"("version");

-- CreateIndex
CREATE INDEX "Estimate_sowHash_idx" ON "Estimate"("sowHash");

-- CreateIndex
CREATE UNIQUE INDEX "RoleLineItem_menuItemId_role_key" ON "RoleLineItem"("menuItemId", "role");

-- AddForeignKey
ALTER TABLE "TaxonomyNodeVersion" ADD CONSTRAINT "TaxonomyNodeVersion_nodeKey_fkey" FOREIGN KEY ("nodeKey") REFERENCES "TaxonomyNode"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresetVersion" ADD CONSTRAINT "PresetVersion_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "Preset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_kind_fkey" FOREIGN KEY ("kind") REFERENCES "Prompt"("kind") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleLineItem" ADD CONSTRAINT "RoleLineItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
