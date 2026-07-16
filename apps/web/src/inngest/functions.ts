import { createHash } from 'node:crypto';
import { prisma } from '@repo/db';
import { createModelProvider, EmbeddingProvider } from '@repo/providers';
import type { InngestFunction } from 'inngest';
import { runEstimate, ingestFiles, type IngestFile } from '@repo/agents';
import { inngest, EVENT_RUN, EVENT_INGEST, type EstimateEventData } from '@/lib/inngest';
import { sendIngestCompleteEmail, sendRunCompleteEmail } from '@/lib/email';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Best-effort owner notification. Runs as its own durable step *after* the
 * estimate is already marked DONE, and must never throw — a mail failure must
 * not flip the estimate to FAILED via onFailure. All errors are swallowed.
 */
async function notifyOwner(
  estimateId: string,
  send: (n: { to: string; name?: string | null; title: string; estimateId: string }) => Promise<{ sent: boolean }>,
): Promise<{ sent: boolean }> {
  try {
    const est = await prisma.estimate.findUnique({
      where: { id: estimateId },
      select: { title: true, owner: { select: { email: true, name: true } } },
    });
    if (!est?.owner?.email) return { sent: false };
    return await send({ to: est.owner.email, name: est.owner.name, title: est.title, estimateId });
  } catch (err) {
    console.error(`[email] notifyOwner failed for estimate ${estimateId}:`, err);
    return { sent: false };
  }
}

/** Best-effort extraction of the original event's estimateId in an onFailure handler. */
function failedEstimateId(failureEvent: unknown): string | undefined {
  const data = (failureEvent as { data?: { event?: { data?: { estimateId?: string } } } })?.data;
  return data?.event?.data?.estimateId;
}

/**
 * Durable estimate run. The whole pipeline runs inside a retriable step; the
 * onProgress hook writes the live stage/pct to the Estimate row so the UI poll
 * stays factual. Terminal status is set here (DONE) and in onFailure (FAILED),
 * so it always reflects Inngest's real execution outcome.
 */
const runEstimateFn = inngest.createFunction(
  {
    id: 'estimate-run',
    name: 'Run estimate',
    retries: 1,
    triggers: [{ event: EVENT_RUN }],
    onFailure: async ({ event, error }) => {
      const estimateId = failedEstimateId(event);
      if (!estimateId) return;
      await prisma.estimate.update({
        where: { id: estimateId },
        data: {
          runStatus: 'FAILED',
          runStage: 'Failed',
          runError: String(error?.message ?? error).slice(0, 500),
          runFinishedAt: new Date(),
        },
      });
    },
  },
  async ({ event, step }) => {
    const { estimateId } = event.data as EstimateEventData;

    // The pipeline checkpoints itself stage-by-stage through this runner, so
    // each agent (and each requirement's specialist council) is a separate
    // invocation with its own execution-time budget and its own retry. Running
    // the whole pipeline as one step would have to fit inside a single Vercel
    // invocation (300s on Hobby), which a multi-requirement run does not.
    const modelProvider = createModelProvider();
    await runEstimate(estimateId, {
      db: prisma,
      modelProvider,
      step: (id, fn) => step.run(id, fn) as ReturnType<typeof fn>,
      // Archivist RAG activates once presets have embeddings — the run
      // itself tolerates all-empty matches (coverage:none everywhere) so
      // this is safe to wire ahead of the embedding backfill completing.
      embeddingProvider: new EmbeddingProvider(modelProvider),
      onProgress: async ({ stage, pct }) => {
        await prisma.estimate.update({
          where: { id: estimateId },
          data: { runStage: stage, runPct: pct },
        });
      },
    });

    await prisma.estimate.update({
      where: { id: estimateId },
      data: { runStatus: 'DONE', runStage: 'Done', runPct: 100, runFinishedAt: new Date() },
    });

    // Notify the owner their estimate is ready (best-effort; own step so a
    // transient mail failure retries without re-running the whole pipeline).
    await step.run('notify-run-complete', () => notifyOwner(estimateId, sendRunCompleteEmail));

    return { estimateId };
  },
);

/**
 * Durable document ingestion. Reads the uploaded bytes persisted by the upload
 * handler (UploadedFile rows), parses them to text (vision/OCR), appends to the
 * SOW, then clears the temp rows. Progress + terminal status mirror the run.
 */
const ingestFn = inngest.createFunction(
  {
    id: 'estimate-ingest',
    name: 'Ingest documents',
    retries: 1,
    triggers: [{ event: EVENT_INGEST }],
    onFailure: async ({ event, error }) => {
      const estimateId = failedEstimateId(event);
      if (!estimateId) return;
      await prisma.estimate.update({
        where: { id: estimateId },
        data: {
          ingestStatus: 'FAILED',
          ingestStage: 'Failed',
          ingestError: String(error?.message ?? error).slice(0, 500),
        },
      });
    },
  },
  async ({ event, step }) => {
    const { estimateId } = event.data as EstimateEventData;

    const result = await step.run('ingest-files', async () => {
      const est = await prisma.estimate.findUniqueOrThrow({
        where: { id: estimateId },
        select: { sowText: true },
      });
      const rows = await prisma.uploadedFile.findMany({ where: { estimateId } });
      const files: IngestFile[] = rows.map((r) => ({
        filename: r.filename,
        mimeType: r.mimeType,
        bytes: new Uint8Array(r.bytes),
      }));

      const { text, files: parsedFiles } = await ingestFiles(files, {
        modelProvider: createModelProvider(),
        onProgress: async ({ stage, pct }) => {
          await prisma.estimate.update({
            where: { id: estimateId },
            data: { ingestStage: stage, ingestPct: pct },
          });
        },
      });

      const failed = parsedFiles.filter((f) => f.error);
      const combined = [est.sowText, text].filter((s) => s.trim().length > 0).join('\n\n');

      // Every file failed to parse (or none produced usable text) and there was
      // no pre-existing SOW text to fall back on — this is not a valid ingest,
      // even though ingestFile() never throws per-file. Fail loudly instead of
      // silently marking DONE on an empty SOW (see estimate-quality-prompt-code-drift
      // memory: a blank SOW previously caused the Librarian to fabricate one).
      if (combined.trim().length === 0) {
        const detail = failed.length
          ? failed.map((f) => `${f.filename}: ${f.error}`).join('; ')
          : 'no files produced any text';
        throw new Error(`Ingestion produced no usable SOW text — ${detail}`);
      }

      // Partial failure: some files parsed, at least one didn't. Not fatal —
      // there's real content to estimate from — but surface it rather than
      // silently dropping the failed file(s) from the SOW.
      const ingestError = failed.length
        ? `${failed.length} of ${parsedFiles.length} file(s) failed to parse: ${failed.map((f) => `${f.filename} (${f.error})`).join('; ')}`.slice(
            0,
            500,
          )
        : null;

      await prisma.estimate.update({
        where: { id: estimateId },
        data: {
          sowText: combined,
          sowHash: sha(combined),
          ingestStatus: 'DONE',
          ingestStage: 'Done',
          ingestPct: 100,
          ingestError,
        },
      });
      await prisma.uploadedFile.deleteMany({ where: { estimateId } });
      return { chars: combined.length, failedFiles: failed.length };
    });

    // Ingestion succeeded (this line is unreachable on the empty-SOW throw
    // above) — tell the owner the SOW is ready to estimate. Best-effort.
    await step.run('notify-ingest-complete', () => notifyOwner(estimateId, sendIngestCompleteEmail));

    return result;
  },
);

export const inngestFunctions: InngestFunction.Any[] = [runEstimateFn, ingestFn];
