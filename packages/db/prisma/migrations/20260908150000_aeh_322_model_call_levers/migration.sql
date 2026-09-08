-- AEH-322: reasoning effort and provider routing become data, alongside the
-- modelString they are coupled to.
--
-- Fully additive: two new enum types and four nullable columns. NULL is the
-- pre-existing behaviour on every row that already exists ("send no such
-- field"), so this migration cannot change what any current version does.

-- CreateEnum
CREATE TYPE "ReasoningEffort" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ProviderSort" AS ENUM ('THROUGHPUT', 'LATENCY', 'PRICE');

-- AlterTable
ALTER TABLE "PromptVersion" ADD COLUMN     "reasoningEffort" "ReasoningEffort",
ADD COLUMN     "providerSort" "ProviderSort";

-- AlterTable
ALTER TABLE "ArtifactTypeVersion" ADD COLUMN     "reasoningEffort" "ReasoningEffort",
ADD COLUMN     "providerSort" "ProviderSort";
