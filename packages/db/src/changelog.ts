import { PrismaClient } from './generated/client/index.js';

export type ChangeLogEntry = {
  entity: string;
  entityKey: string;
  version: number;
  changeReason: string | null;
  changeMotivation: string;
  createdAt: Date;
  createdBy: string | null;
};

export async function getChangeLog(db: PrismaClient, limit = 100): Promise<ChangeLogEntry[]> {
  const rows = await db.$queryRaw<ChangeLogEntry[]>`
    SELECT 'preset' AS entity, "presetId" AS "entityKey", version,
           "changeReason", "changeMotivation"::text, "createdAt", "createdBy"
    FROM "PresetVersion"
    UNION ALL
    SELECT 'taxonomy' AS entity, "nodeKey" AS "entityKey", version,
           "changeReason", "changeMotivation"::text, "createdAt", "createdBy"
    FROM "TaxonomyNodeVersion"
    UNION ALL
    SELECT 'prompt' AS entity, kind::text AS "entityKey", version,
           "changeReason", "changeMotivation"::text, "createdAt", "createdBy"
    FROM "PromptVersion"
    UNION ALL
    SELECT 'config' AS entity, version::text AS "entityKey", version,
           "changeReason", "changeMotivation"::text, "createdAt", NULL AS "createdBy"
    FROM "EstimationConfig"
    ORDER BY "createdAt" DESC
    LIMIT ${limit}
  `;
  return rows;
}
