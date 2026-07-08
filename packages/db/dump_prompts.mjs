import { PrismaClient } from './src/generated/client/index.js';
const db = new PrismaClient();
const prompts = await db.promptVersion.findMany({
  where: { active: true },
  orderBy: { kind: 'asc' },
  select: { kind: true, version: true, modelString: true, body: true },
});
for (const p of prompts) {
  console.log(`\n===== ${p.kind} v${p.version} (${p.modelString}) =====`);
  console.log(p.body);
}
await db.$disconnect();
