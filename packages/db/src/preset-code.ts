import type { PrismaClient } from './generated/client/index.js';

/**
 * Readable preset handles — "P46".
 *
 * Deliberately NOT `max(code) + 1`. Allocation is concurrent: two estimates
 * finalising at the same moment would both read the same max, then one would hit
 * the unique constraint (or, without it, two presets would silently share a
 * code). A Postgres sequence is atomic and needs no locking, so this stays
 * correct under any amount of parallelism — including Inngest retrying a
 * promotion while another is mid-flight.
 *
 * Numbers are free-flowing: no zero padding, no fixed width. Codes imported
 * from the xlsx keep that file's own formatting (P01–P45), because people
 * cross-reference the spreadsheet; allocated codes are plain.
 */
const SEQUENCE = 'preset_code_seq';
const PREFIX = 'P';

/** Allocate the next preset code. Safe to call concurrently. */
export async function allocatePresetCode(db: PrismaClient): Promise<string> {
  const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT nextval('${SEQUENCE}') AS n`,
  );
  const n = rows[0]?.n;
  if (n == null) throw new Error(`Could not allocate a preset code from ${SEQUENCE}`);
  return `${PREFIX}${n}`;
}

/**
 * Move the sequence past the highest number already present, so an allocated
 * code can never collide with one that arrived some other way (an xlsx import
 * adding P46, a restored backup). Idempotent, and only ever moves forward —
 * `GREATEST` with the sequence's own value means calling this can't hand back
 * a code that was already issued.
 */
export async function syncPresetCodeSequence(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    // `setval(..., false)` means "the next nextval returns this", so
    // `last_value` is already the next value — the +1 belongs on the max only.
    // Adding it outside GREATEST would advance the sequence by one on every
    // call, which is not idempotent.
    `SELECT setval('${SEQUENCE}', GREATEST(
       COALESCE((SELECT max(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::bigint) FROM "Preset"), 0) + 1,
       (SELECT last_value FROM ${SEQUENCE})
     ), false)`,
  );
}
