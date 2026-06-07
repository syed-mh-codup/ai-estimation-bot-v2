import type { PrismaClient, AgentKind, PromptVersion } from '@repo/db';

export type ActivePrompt = {
  body: string;
  modelString: string;
  version: number;
  kind: AgentKind;
};

export class PromptNotFoundError extends Error {
  constructor(kind: AgentKind) {
    super(`No active prompt version found for agent kind: ${kind}`);
    this.name = 'PromptNotFoundError';
  }
}

/**
 * Load the active PromptVersion for a given AgentKind.
 * Throws PromptNotFoundError if none is active.
 */
export async function loadActivePrompt(
  db: PrismaClient,
  kind: AgentKind,
): Promise<ActivePrompt> {
  const pv = await db.promptVersion.findFirst({
    where: { kind, active: true },
    orderBy: { version: 'desc' },
  });

  if (!pv) {
    throw new PromptNotFoundError(kind);
  }

  return { body: pv.body, modelString: pv.modelString, version: pv.version, kind: pv.kind };
}

/**
 * List all prompt versions for a kind, ordered by version desc.
 */
export async function listPromptVersions(
  db: PrismaClient,
  kind: AgentKind,
): Promise<PromptVersion[]> {
  return db.promptVersion.findMany({
    where: { kind },
    orderBy: { version: 'desc' },
  });
}

/**
 * Create a new prompt version and activate it (deactivates all prior for this kind).
 * Returns the new version number.
 */
export async function activateNewPromptVersion(
  db: PrismaClient,
  kind: AgentKind,
  body: string,
  modelString: string,
  meta: { reason?: string; motivation?: string; by?: string } = {},
): Promise<number> {
  const last = await db.promptVersion.findFirst({
    where: { kind },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (last?.version ?? 0) + 1;

  await db.$transaction([
    db.promptVersion.updateMany({ where: { kind }, data: { active: false } }),
    db.promptVersion.create({
      data: {
        kind,
        version: nextVersion,
        body,
        modelString,
        active: true,
        changeReason: meta.reason,
        changeMotivation: (meta.motivation as 'OTHER') ?? 'OTHER',
        createdBy: meta.by,
      },
    }),
  ]);

  return nextVersion;
}
