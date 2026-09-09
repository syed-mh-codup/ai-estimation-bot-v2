import { Prisma } from './generated/client/index.js';
import type {
  EstimateStatement as EstimateStatementRow,
  LineProvenance,
  PrismaClient,
  StatementKind,
} from './generated/client/index.js';

/**
 * The narrative and the assumptions, as addressable rows — AEH-238.
 *
 * These were two `String[]` columns on `Estimate` until this ticket. Everything
 * here exists because a bare string in an ordered array has no identity, and
 * three things needed one: a lock aimed at "assumption 4" would have pinned an
 * array INDEX, which stops meaning the same thing the moment a line is inserted
 * above it; an audit snapshot could only say "the assumptions changed"; and a
 * steered edit aimed at one assumption had nothing to aim at.
 *
 * One thing to hold onto when changing this file: `order` is presentational and
 * nothing addresses a statement by it. Gaps are fine, and a reorder rewrites
 * the column rather than shuffling ids, because the id is the identity.
 */

export type StatementRow = Pick<
  EstimateStatementRow,
  'id' | 'text' | 'order' | 'provenance' | 'kind'
>;

const STATEMENT_SELECT = {
  id: true,
  text: true,
  order: true,
  provenance: true,
  kind: true,
} as const;

/** Both lists for one estimate, each in its own order. */
export async function loadStatements(
  db: PrismaClient,
  estimateId: string,
): Promise<{ narrative: StatementRow[]; assumptions: StatementRow[] }> {
  const rows = await db.estimateStatement.findMany({
    where: { estimateId },
    orderBy: [{ kind: 'asc' }, { order: 'asc' }],
    select: STATEMENT_SELECT,
  });
  return {
    narrative: rows.filter((r) => r.kind === 'NARRATIVE'),
    assumptions: rows.filter((r) => r.kind === 'ASSUMPTION'),
  };
}

/** Just the text, in order — for the readers that only render prose. */
export async function loadStatementTexts(
  db: PrismaClient,
  estimateId: string,
): Promise<{ narrative: string[]; assumptions: string[] }> {
  const { narrative, assumptions } = await loadStatements(db, estimateId);
  return {
    narrative: narrative.map((n) => n.text),
    assumptions: assumptions.map((a) => a.text),
  };
}

/**
 * Replace one kind's list wholesale. What a run does.
 *
 * Takes a transaction client so it can sit inside the pipeline's persist, where
 * everything else about the estimate is being written at once.
 *
 * It replaces rather than reconciles, and that is a real loss worth naming: a
 * re-run discards whichever of these lines a person had rewritten, because
 * nothing here can tell which of two similar sentences is the human's revision
 * of the crew's. `provenance` is what makes that answerable in future — a
 * reconciling re-run that keeps the HUMAN rows is now expressible, and belongs
 * with AEH-367, where the same problem is recorded for line items.
 */
export async function replaceStatements(
  tx: Prisma.TransactionClient,
  args: {
    estimateId: string;
    kind: StatementKind;
    texts: string[];
    provenance?: LineProvenance;
  },
): Promise<void> {
  const { estimateId, kind, texts, provenance = 'CREW' } = args;
  await tx.estimateStatement.deleteMany({ where: { estimateId, kind } });
  const clean = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (clean.length === 0) return;
  await tx.estimateStatement.createMany({
    data: clean.map((text, order) => ({ estimateId, kind, text, order, provenance })),
  });
}

/**
 * Reconcile one kind's list against what the editor sent.
 *
 * The editor works in whole lists — it is a list of text boxes — so this takes
 * one and preserves identity across it: a row whose text is unchanged keeps its
 * id, its provenance and anything pointing at it, and only genuinely new text
 * becomes a new row.
 *
 * Matching is by TEXT, not by position, and the difference matters. Position
 * matching would treat inserting a line at the top as "every line changed",
 * which would restamp the whole list as HUMAN and destroy exactly the signal
 * the provenance column exists to carry. Text matching gets that case right and
 * is wrong only when somebody edits two lines to swap their wording, which
 * costs nothing but a provenance stamp.
 */
export async function reconcileStatements(
  db: PrismaClient,
  args: {
    estimateId: string;
    kind: StatementKind;
    texts: string[];
    /** What to stamp on text that is new. A person typing means HUMAN. */
    provenance?: LineProvenance;
  },
): Promise<StatementRow[]> {
  const { estimateId, kind, provenance = 'HUMAN' } = args;
  const texts = args.texts.map((t) => t.trim()).filter((t) => t.length > 0);

  const existing = await db.estimateStatement.findMany({
    where: { estimateId, kind },
    select: STATEMENT_SELECT,
  });

  // First unclaimed row with this exact text keeps its identity.
  //
  // Keyed on the TRIMMED stored text, to match the trimmed submitted list. No
  // writer here stores untrimmed text and the real database has none, but the
  // AEH-238 backfill inserted raw values: one with a trailing space would
  // never have matched, so the row would be deleted and recreated on the next
  // blur, losing its id, its provenance and any lock pointing at it.
  const unclaimed = new Map<string, StatementRow[]>();
  for (const row of existing) {
    const key = row.text.trim();
    const bucket = unclaimed.get(key);
    if (bucket) bucket.push(row);
    else unclaimed.set(key, [row]);
  }

  const keep: Array<{ id: string; order: number }> = [];
  const create: Array<{ text: string; order: number }> = [];
  texts.forEach((text, order) => {
    const match = unclaimed.get(text)?.shift();
    if (match) keep.push({ id: match.id, order });
    else create.push({ text, order });
  });

  const keptIds = new Set(keep.map((k) => k.id));
  const remove = existing.filter((e) => !keptIds.has(e.id)).map((e) => e.id);

  await db.$transaction(
    async (tx) => {
      if (remove.length > 0) {
        await tx.estimateStatement.deleteMany({ where: { id: { in: remove } } });
      }
      if (keep.length > 0) {
        // ONE statement for the whole reorder, and this is not a micro
        // optimisation — it is the difference between this function working and
        // not.
        //
        // It was a loop of `updateMany`, one round trip per kept row, inside an
        // interactive transaction whose Prisma default timeout is five seconds.
        // On an estimate with 485 assumptions, deleting a single line leaves
        // 484 order updates: at Neon's round-trip latency that blows straight
        // through the timeout, nothing commits, the action throws, and the
        // editor reverts to the list it had. Which reads, from the outside,
        // exactly like "I deleted my assumptions and they came back" — and
        // whatever somebody typed instead was never written at all.
        //
        // `updatedAt` is deliberately untouched: it is a staleness signal the
        // edit engine reads, and a save that only renumbered must not make
        // every line look freshly edited. Hence `WHERE s."order" <> v."order"`
        // rather than an unconditional write.
        //
        // Both columns are cast in the VALUES list because Postgres cannot
        // infer a bound parameter's type there and fails with "could not
        // determine data type of column".
        await tx.$executeRaw`
          UPDATE "EstimateStatement" AS s
          SET "order" = v."order"
          FROM (VALUES ${Prisma.join(
            keep.map((k) => Prisma.sql`(${k.id}::text, ${k.order}::int)`),
          )}) AS v(id, "order")
          WHERE s.id = v.id AND s."order" <> v."order"
        `;
      }
      if (create.length > 0) {
        await tx.estimateStatement.createMany({
          data: create.map((c) => ({ estimateId, kind, text: c.text, order: c.order, provenance })),
        });
      }
    },
    // Generous even so. Three statements over a remote database is nothing
    // like the old loop, but a 500-line list is a real size and the default
    // 5s is not a budget worth being anywhere near.
    { maxWait: 15_000, timeout: 60_000 },
  );

  return (await loadStatements(db, estimateId))[
    kind === 'NARRATIVE' ? 'narrative' : 'assumptions'
  ];
}

/**
 * Add one statement to the end of its list.
 *
 * Exists separately from `reconcileStatements` for the Oracle's suggested
 * assumption, which is one line arriving on its own from a surface that is not
 * the list editor and does not know what else is in the list.
 */
export async function appendStatement(
  db: PrismaClient,
  args: {
    estimateId: string;
    kind: StatementKind;
    text: string;
    provenance?: LineProvenance;
  },
): Promise<StatementRow> {
  const { estimateId, kind, provenance = 'HUMAN' } = args;
  const text = args.text.trim();
  if (text.length === 0) throw new Error('An empty statement is not worth recording');
  const max = await db.estimateStatement.aggregate({
    where: { estimateId, kind },
    _max: { order: true },
  });
  return db.estimateStatement.create({
    data: { estimateId, kind, text, order: (max._max.order ?? -1) + 1, provenance },
    select: STATEMENT_SELECT,
  });
}
