import type { PrismaClient, ChangeMotivation, Prisma } from '@repo/db';

export type VersionedEntityKind = 'preset' | 'taxonomy' | 'prompt' | 'config';

export type VersionMetadata = {
  reason?: string;
  motivation?: ChangeMotivation;
  by?: string;
};

// ─── Generic versionedCreate ──────────────────────────────────────────────────

type PresetPayload = {
  presetId: string;
  version: number;
  active: boolean;
  category: string;
  name: string;
  description: string;
  /**
   * ONE dev figure, matching PresetVersion.devHours. This type still declared
   * `beHours`/`feHours` after the model unified to a single number, so
   * `createPresetVersion` could not compile and would have thrown at runtime on
   * the now-required `devHours` — a fourth PresetVersion writer left behind by
   * the unification, invisible while CI was not running typecheck.
   */
  devHours: number;
  /** What that figure covers. Never a basis for dividing it. */
  touchesFrontend?: boolean;
  touchesBackend?: boolean;
  platforms: string[];
  reqType: string;
  keywords: string[];
  userStoryTags: string[];
  projectSizeFit: string[];
  integrationCount: number;
  dataVolume: 'NONE' | 'LOW' | 'HIGH';
  phase: 'FOUNDATION' | 'CORE' | 'ENHANCEMENT';
  requires: string[];
  blocks: string[];
  canParallel: boolean;
  aiAssist: 'LOW' | 'MEDIUM' | 'HIGH';
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  spikeNeeded: boolean;
  notes: string;
  taxonomyKey?: string;
  changeReason?: string;
  changeMotivation?: ChangeMotivation;
  createdBy?: string;
};

type TaxonomyPayload = {
  nodeKey: string;
  version: number;
  label: string;
  reqType?: string;
  keywords: string[];
  changeReason?: string;
  changeMotivation?: ChangeMotivation;
  createdBy?: string;
};

type PromptPayload = {
  kind: 'SUPERVISOR' | 'LIBRARIAN' | 'DETECTIVE' | 'ARCHIVIST' | 'SPECIALIST_DEV' | 'SPECIALIST_QA' | 'SPECIALIST_PM' | 'SPECIALIST_BA' | 'ARCHITECT';
  version: number;
  body: string;
  modelString: string;
  changeReason?: string;
  changeMotivation?: ChangeMotivation;
  createdBy?: string;
};

/**
 * Create a new version of a preset; deactivate all prior versions for the same presetId.
 * Returns the new version number.
 */
export async function createPresetVersion(
  db: PrismaClient,
  presetId: string,
  payload: Omit<PresetPayload, 'presetId' | 'version' | 'active'>,
  meta: VersionMetadata = {},
): Promise<number> {
  const last = await db.presetVersion.findFirst({
    where: { presetId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (last?.version ?? 0) + 1;

  await db.$transaction([
    db.presetVersion.updateMany({ where: { presetId }, data: { active: false } }),
    db.presetVersion.create({
      data: {
        ...payload,
        presetId,
        version: nextVersion,
        active: true,
        changeReason: meta.reason,
        changeMotivation: meta.motivation ?? 'OTHER',
        createdBy: meta.by,
      },
    }),
  ]);

  return nextVersion;
}

/**
 * Create a new version of a taxonomy node; deactivate all prior versions.
 */
export async function createTaxonomyVersion(
  db: PrismaClient,
  nodeKey: string,
  payload: Omit<TaxonomyPayload, 'nodeKey' | 'version'>,
  meta: VersionMetadata = {},
): Promise<number> {
  const last = await db.taxonomyNodeVersion.findFirst({
    where: { nodeKey },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (last?.version ?? 0) + 1;

  await db.$transaction([
    db.taxonomyNodeVersion.updateMany({ where: { nodeKey }, data: { active: false } }),
    db.taxonomyNodeVersion.create({
      data: {
        ...payload,
        nodeKey,
        version: nextVersion,
        active: true,
        changeReason: meta.reason,
        changeMotivation: meta.motivation ?? 'OTHER',
        createdBy: meta.by,
      },
    }),
  ]);

  return nextVersion;
}

/**
 * Create a new version of a prompt; deactivate all prior versions for the same kind.
 */
export async function createPromptVersion(
  db: PrismaClient,
  payload: Omit<PromptPayload, 'version'>,
  meta: VersionMetadata = {},
): Promise<number> {
  const last = await db.promptVersion.findFirst({
    where: { kind: payload.kind },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (last?.version ?? 0) + 1;

  await db.$transaction([
    db.promptVersion.updateMany({ where: { kind: payload.kind }, data: { active: false } }),
    db.promptVersion.create({
      data: {
        ...payload,
        version: nextVersion,
        active: true,
        changeReason: meta.reason,
        changeMotivation: meta.motivation ?? 'OTHER',
        createdBy: meta.by,
      },
    }),
  ]);

  return nextVersion;
}

/**
 * Create a new EstimationConfig version; deactivate all prior active configs.
 */
export async function createConfigVersion(
  db: PrismaClient,
  payload: {
    complexityRules: Record<string, unknown>;
    pmCommunicationTaxPct: number;
    baCommunicationTaxPct: number;
    qaRegressionBufferPct: number;
    infraBaseline: Record<string, unknown>;
  },
  meta: VersionMetadata = {},
): Promise<number> {
  const last = await db.estimationConfig.findFirst({
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (last?.version ?? 0) + 1;

  await db.$transaction([
    db.estimationConfig.updateMany({ where: { active: true }, data: { active: false } }),
    db.estimationConfig.create({
      data: {
        ...payload,
        // Json columns: Prisma types these as InputJsonValue, which a plain
        // Record<string, unknown> is not assignable to (unknown could be a
        // non-serialisable value). The payload is JSON by construction.
        complexityRules: payload.complexityRules as Prisma.InputJsonValue,
        infraBaseline: payload.infraBaseline as Prisma.InputJsonValue,
        version: nextVersion,
        active: true,
        changeReason: meta.reason,
        changeMotivation: meta.motivation ?? 'OTHER',
      },
    }),
  ]);

  return nextVersion;
}

// ─── resolveActiveVersions + pinVersions (WS6-02) ────────────────────────────

export type PinnedVersions = {
  taxonomyVersion: number;
  configVersion: number;
  promptVersions: Record<string, number>;
};

export async function resolveActiveVersions(db: PrismaClient): Promise<PinnedVersions> {
  const [latestTax, latestCfg, latestPrompts] = await Promise.all([
    db.taxonomyNodeVersion.findFirst({ where: { active: true }, orderBy: { version: 'desc' } }),
    db.estimationConfig.findFirst({ where: { active: true }, orderBy: { version: 'desc' } }),
    db.promptVersion.findMany({ where: { active: true } }),
  ]);

  const promptVersions: Record<string, number> = {};
  for (const p of latestPrompts) {
    promptVersions[p.kind] = p.version;
  }

  return {
    taxonomyVersion: latestTax?.version ?? 0,
    configVersion: latestCfg?.version ?? 0,
    promptVersions,
  };
}

export async function pinVersions(
  db: PrismaClient,
  estimateId: string,
): Promise<PinnedVersions> {
  const versions = await resolveActiveVersions(db);
  await db.estimate.update({
    where: { id: estimateId },
    data: {
      // Both are Json columns; a bare number and a Record<string, number> are
      // each valid JSON. (Unchanged behaviour — these were previously cast
      // through `unknown` to a Record, which no longer typechecks.)
      taxonomyVersionsPinned: versions.taxonomyVersion satisfies number as Prisma.InputJsonValue,
      configVersion: versions.configVersion,
      promptVersionsPinned: versions.promptVersions satisfies Record<
        string,
        number
      > as Prisma.InputJsonValue,
    },
  });
  return versions;
}

// ─── Diff helper (WS6-03) ─────────────────────────────────────────────────────

export type FieldDiff = {
  field: string;
  before: unknown;
  after: unknown;
};

export function diffVersions(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const a = before[key];
    const b = after[key];
    const aStr = JSON.stringify(a);
    const bStr = JSON.stringify(b);
    if (aStr !== bStr) {
      diffs.push({ field: key, before: a, after: b });
    }
  }
  return diffs;
}
