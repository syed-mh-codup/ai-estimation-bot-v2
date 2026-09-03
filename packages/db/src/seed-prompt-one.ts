/**
 * Install ONE agent's prompt into an environment that already has live prompts.
 *
 * DO NOT use the bootstrap seed for this. `seed.ts` deactivates every active
 * PromptVersion for a kind and then force-activates version 1, overwriting its
 * body and modelString with the seed text. Against an environment where prompts
 * have been tuned at /admin/prompts — which mints v2, v3, v4… and never touches
 * the repo — one run reverts all of them to their two-sentence bootstrap bodies,
 * silently. The versions survive in history; the active pointer and v1's body
 * do not.
 *
 * So this script does the narrow thing instead: it touches the one kind it is
 * given and nothing else, and it refuses to overwrite anything already there.
 * Running it twice is a no-op.
 *
 * Generalised from a copy that was hardcoded to ORACLE. A second agent needing
 * the same careful install is exactly when duplicating it would have started
 * the drift this file exists to prevent.
 *
 *   pnpm db:seed:prompt ORACLE
 *   pnpm db:seed:prompt CARTOGRAPHER
 */
import { AGENT_CATALOGUE } from './agent-catalogue';
import type { AgentKind } from './generated/client/index.js';
import { PrismaClient } from './generated/client/index.js';
import { SEED_PROMPTS } from './seed-prompts';

const prisma = new PrismaClient();

function parseKind(raw: string | undefined): AgentKind {
  const known = AGENT_CATALOGUE.map((a) => a.kind);
  if (!raw) {
    throw new Error(`Which agent? Pass a kind, one of: ${known.join(', ')}`);
  }
  const kind = raw.toUpperCase() as AgentKind;
  // Checked against the catalogue rather than the Prisma enum, because the
  // catalogue is what /admin/prompts renders — a kind it does not know about
  // would install a prompt with no screen to edit it on.
  if (!known.includes(kind)) {
    throw new Error(`Unknown agent kind "${raw}". Known: ${known.join(', ')}`);
  }
  return kind;
}

async function main(): Promise<void> {
  const kind = parseKind(process.argv[2]);

  const seed = SEED_PROMPTS.find((p) => p.kind === kind);
  if (!seed) throw new Error(`No ${kind} entry in SEED_PROMPTS`);

  const existing = await prisma.promptVersion.findFirst({
    where: { kind },
    orderBy: { version: 'desc' },
    select: { version: true, active: true },
  });

  if (existing) {
    // Already installed. Re-writing the body here would be the exact failure
    // this script exists to avoid, one kind at a time.
    console.log(
      `${kind} already has v${existing.version} (${existing.active ? 'active' : 'inactive'}). ` +
        'Nothing changed — edit it at /admin/prompts.',
    );
    return;
  }

  await prisma.prompt.upsert({ where: { kind }, update: {}, create: { kind } });
  await prisma.promptVersion.create({
    data: {
      kind,
      version: 1,
      body: seed.body,
      modelString: seed.modelString,
      active: true,
      changeReason: `${kind} prompt installed by seed-prompt-one`,
    },
  });

  console.log(`Installed ${kind} v1 on ${seed.modelString}. No other prompt was touched.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
