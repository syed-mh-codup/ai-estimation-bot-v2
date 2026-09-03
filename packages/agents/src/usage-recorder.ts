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
  /**
   * The generated document this spend belongs to, when it is artifact
   * generation. AEH-239.
   *
   * A column rather than a usage kind per artifact type, because artifact types
   * are rows: a per-type kind would be a migration per type. Every artifact call
   * records `kind: 'ARTIFACT'`, and this is what makes "what did THIS document
   * cost" answerable — which matters more here than for a run, since one
   * artifact is N+2 calls rather than one.
   */
  artifactId?: string | null;
}): UsageRecorder {
  const { db, estimateId, runId = null, artifactId = null } = opts;

  return {
    async record(input) {
      // Never let accounting fail the thing being accounted for. This runs
      // inside a memoised Inngest step, immediately after a model call that has
      // already been billed — so a throw here fails the step, and the retry
      // pays for the same call a second time. A missing row is cheaper than a
      // duplicated charge, and the ticket's own rule is that double-counting is
      // worse than not counting.
      try {
        await db.modelUsage.create({
          data: {
            estimateId,
            runId,
            artifactId,
            kind: input.kind,
            model: input.model,
            promptTokens: input.usage?.promptTokens ?? null,
            completionTokens: input.usage?.completionTokens ?? null,
            costUsd: input.usage?.costUsd ?? null,
          },
        });
      } catch (err) {
        // Loud in the log, invisible to the pipeline. An under-reported total is
        // a known failure mode; a re-billed run is not.
        console.error(
          `[usage] failed to record ${input.kind} call (estimate=${estimateId ?? 'none'} run=${runId ?? 'none'}):`,
          err,
        );
      }
    },
  };
}
