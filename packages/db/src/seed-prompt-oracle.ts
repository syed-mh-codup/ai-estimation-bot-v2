/**
 * Install Oracle's prompt into an environment that already has live prompts.
 *
 * DO NOT use the bootstrap seed for this. `seed.ts` deactivates every active
 * PromptVersion for a kind and then force-activates version 1, overwriting its
 * body and modelString with the seed text. Against an environment where prompts
 * have been tuned at /admin/prompts — which mints v2, v3, v4… and never touches
 * the repo — one run reverts all of them to their two-sentence bootstrap bodies,
 * silently. The versions survive in history; the active pointer and v1's body
 * do not.
 *
 * So this script does the narrow thing instead: it touches the ORACLE kind and
 * nothing else, and it refuses to overwrite anything that is already there.
 * Running it twice is a no-op.
 *
 *   pnpm db:seed:oracle
 */
import { PrismaClient } from './generated/client/index.js';
import { SEED_PROMPTS } from './seed-prompts';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const seed = SEED_PROMPTS.find((p) => p.kind === 'ORACLE');
  if (!seed) throw new Error('No ORACLE entry in SEED_PROMPTS');

  const existing = await prisma.promptVersion.findFirst({
    where: { kind: 'ORACLE' },
    orderBy: { version: 'desc' },
    select: { version: true, active: true },
  });

  if (existing) {
    // Already installed. Re-writing the body here would be the exact failure
    // this script exists to avoid, one kind at a time.
    console.log(
      `ORACLE already has v${existing.version} (${existing.active ? 'active' : 'inactive'}). ` +
        'Nothing changed — edit it at /admin/prompts.',
    );
    return;
  }

  await prisma.prompt.upsert({
    where: { kind: 'ORACLE' },
    update: {},
    create: { kind: 'ORACLE' },
  });
  await prisma.promptVersion.create({
    data: {
      kind: 'ORACLE',
      version: 1,
      body: seed.body,
      modelString: seed.modelString,
      active: true,
      changeReason: 'Oracle introduced (AEH-259)',
    },
  });

  console.log(`Installed ORACLE v1 on ${seed.modelString}. No other prompt was touched.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
