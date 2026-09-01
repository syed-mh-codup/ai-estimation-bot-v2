import type { PrismaClient, UsageKind } from '@repo/db';
import type { TokenUsage } from '@repo/providers';

/**
 * Persists what one model call cost, in the domain layer.
 *
 * The provider stays domain-free — it returns usage; it does not know what an
 * estimate is. This recorder turns that usage into a ModelUsage row tagged with
 * the estimate, the run and the usage kind, and is deliberately a plain object
 * so agents can take it without pulling in Prisma's client type anywhere but
 * here.
 */
export interface UsageRecorder {
  record(input: {
    kind: UsageKind;
    model: string | null;
    usage: TokenUsage | null;
  }): Promise<void>;
}

export function createUsageRecorder(opts: {
  db: PrismaClient;
  estimateId: string | null;
  runId?: string | null;
}): UsageRecorder {
  const { db, estimateId, runId = null } = opts;

  return {
    async record(input) {
      await db.modelUsage.create({
        data: {
          estimateId,
          runId,
          kind: input.kind,
          model: input.model,
          promptTokens: input.usage?.promptTokens ?? null,
          completionTokens: input.usage?.completionTokens ?? null,
          costUsd: input.usage?.costUsd ?? null,
        },
      });
    },
  };
}
