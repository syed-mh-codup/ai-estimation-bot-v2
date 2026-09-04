/**
 * Repair the diagram blocks in artifacts already generated. AEH-330.
 *
 * The fixes in AEH-330 sit in the GENERATION path, so every document already
 * in the database keeps the notation it was written with — and regenerating
 * does not help, because the section step skips a section whose row already
 * exists, which is exactly what makes a resume cheap. The repair therefore has
 * to be applied to the stored rows.
 *
 * Free: no model call. Two passes per artifact.
 *
 *   1. `normaliseDiagramBlocks` over each stored section's html, which quotes
 *      the labels that could not parse.
 *   2. `assembleArtifact` over the result, because the finished document is a
 *      single blob in `EstimateArtifact.content` and it carries a COPY of the
 *      renderer — so the "Syntax error" bomb sweep only reaches an existing
 *      document by rebuilding it.
 *
 * What this CANNOT fix is wording. A label the model wrote wrongly — the `CUST`
 * prefix the data flow brief taught it — is content, not syntax, and needs a
 * regeneration against a corrected brief.
 *
 * Dry by default. Pass --apply to write.
 */
import { PrismaClient } from '@repo/db';

import { assembleArtifact, type ShellSection } from '../artifact-shell';
import { normaliseDiagramBlocks } from '../artifacts';

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const db = new PrismaClient();

  const artifacts = await db.estimateArtifact.findMany({
    where: { status: 'DONE', content: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      title: true,
      content: true,
      createdAt: true,
      finishedAt: true,
      artifactType: { select: { name: true, key: true } },
      estimate: { select: { title: true } },
      sections: {
        orderBy: { order: 'asc' },
        select: { id: true, sectionId: true, title: true, html: true },
      },
    },
  });

  let touchedArtifacts = 0;
  let touchedSections = 0;
  let rebuiltOnly = 0;

  for (const a of artifacts) {
    if (!a.sections.length) continue;

    const changed: { id: string; sectionId: string; html: string }[] = [];
    const shell: ShellSection[] = [];

    let failed: string | null = null;
    for (const s of a.sections) {
      let next = s.html;
      try {
        next = normaliseDiagramBlocks(s.html, s.title);
      } catch (e) {
        // A block the repair rejects outright. Leave the artifact completely
        // alone and report it: a half-repaired document is worse than one that
        // is consistently as it was.
        failed = `${s.sectionId}: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
      if (next !== s.html) changed.push({ id: s.id, sectionId: s.sectionId, html: next });
      shell.push({ sectionId: s.sectionId, title: s.title, html: next });
    }

    if (failed) {
      console.log(`  SKIP  ${a.id} [${a.artifactType.key}] — ${failed}`);
      continue;
    }

    const when = (a.finishedAt ?? a.createdAt).toISOString().slice(0, 10);
    const rebuilt = assembleArtifact(
      {
        title: a.title ?? a.artifactType.name,
        subtitle: a.estimate.title,
        footer: `${a.artifactType.name} · generated from the estimate "${a.estimate.title}" on ${when}. Figures are the estimate's own at the time of generation.`,
      },
      shell,
    );

    const contentChanged = rebuilt !== a.content;
    if (!changed.length && !contentChanged) continue;

    if (changed.length) {
      touchedArtifacts += 1;
      touchedSections += changed.length;
    } else {
      rebuiltOnly += 1;
    }

    console.log(
      `  ${APPLY ? 'FIX ' : 'WOULD'}  ${a.id} [${a.artifactType.key}] ` +
        `sections repaired: ${changed.length ? changed.map((c) => c.sectionId).join(', ') : 'none'}` +
        `${contentChanged ? ' · document rebuilt' : ''}`,
    );

    if (APPLY) {
      await db.$transaction([
        ...changed.map((c) =>
          db.artifactSection.update({ where: { id: c.id }, data: { html: c.html } }),
        ),
        db.estimateArtifact.update({ where: { id: a.id }, data: { content: rebuilt } }),
      ]);
    }
  }

  console.log(
    `\n${APPLY ? 'applied' : 'dry run'}: ${artifacts.length} finished artifacts scanned, ` +
      `${touchedArtifacts} with a repaired section (${touchedSections} sections), ` +
      `${rebuiltOnly} rebuilt for the renderer only.`,
  );
  if (!APPLY) console.log('nothing was written. re-run with --apply');
  await db.$disconnect();
}

void main();
