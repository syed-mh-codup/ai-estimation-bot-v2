-- CreateTable
CREATE TABLE "ScopeScenario" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScopeScenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScopeScenarioPick" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,

    CONSTRAINT "ScopeScenarioPick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScopeScenario_estimateId_idx" ON "ScopeScenario"("estimateId");

-- CreateIndex
CREATE INDEX "ScopeScenarioPick_menuItemId_idx" ON "ScopeScenarioPick"("menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ScopeScenarioPick_scenarioId_menuItemId_key" ON "ScopeScenarioPick"("scenarioId", "menuItemId");

-- AddForeignKey
ALTER TABLE "ScopeScenario" ADD CONSTRAINT "ScopeScenario_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScopeScenario" ADD CONSTRAINT "ScopeScenario_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScopeScenarioPick" ADD CONSTRAINT "ScopeScenarioPick_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "ScopeScenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScopeScenarioPick" ADD CONSTRAINT "ScopeScenarioPick_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
