import { prisma } from '@repo/db';
import { createModelProvider, EmbeddingProvider } from '@repo/providers';
import type { InngestFunction } from 'inngest';
import { runEstimate, ingestFiles, backfillPresetEmbeddings, promoteEstimate, createUsageRecorder, runArtifact, type IngestFile } from '@repo/agents';
import {
  inngest,
  EVENT_RUN,
  EVENT_INGEST,
  EVENT_EMBED_PRESETS,
  EVENT_PROMOTE,
  EVENT_ARTIFACT,
  type EstimateEventData,
  type EmbedPresetsEventData,
  type PromoteEventData,
  type ArtifactEventData,
} from '@/lib/inngest';
import { sendDueReminderEmail, sendIngestCompleteEmail, sendRunCompleteEmail } from '@/lib/email';
import { sweepDueReminders } from '@/lib/reminders';
import { artifactModelProvider } from '@/lib/artifact-provider';


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
    const { estimateId, runId } = event.data as EstimateEventData;

    // The pipeline checkpoints itself stage-by-stage through this runner, so
    // each agent (and each requirement's specialist council) is a separate
    // invocation with its own execution-time budget and its own retry. Running
    // the whole pipeline as one step would have to fit inside a single Vercel
    // invocation (300s on Hobby), which a multi-requirement run does not.
    const modelProvider = createModelProvider();
    await runEstimate(estimateId, {
      db: prisma,
      modelProvider,
      runId,
      step: (id, fn) => step.run(id, fn) as ReturnType<typeof fn>,
      // Archivist RAG needs the preset library embedded (`pnpm db:embed:presets`,
      // or the preset-embed function below). The run tolerates all-empty
      // matches (coverage:none everywhere), so this is safe either way.
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
        recorder: createUsageRecorder({ db: prisma, estimateId }),
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

/**
 * Keep the preset library visible to the Archivist.
 *
 * Retrieval filters on `embedding IS NOT NULL`, so an un-embedded preset never
 * matches anything — silently, with no error. Admin edits carry the previous
 * vector forward and fire this to refresh it; the same function with no
 * `presetIds` sweeps the whole library. `backfillPresetEmbeddings` is
 * idempotent and skips rows already in sync, so a retry costs nothing.
 */
const embedPresetsFn = inngest.createFunction(
  { id: 'preset-embed', name: 'Embed presets', retries: 2, triggers: [{ event: EVENT_EMBED_PRESETS }] },
  async ({ event, step }) => {
    const { presetIds } = (event.data ?? {}) as EmbedPresetsEventData;
    return step.run('embed', async () => {
      const result = await backfillPresetEmbeddings(prisma, new EmbeddingProvider(createModelProvider()), {
        ...(presetIds ? { presetIds } : {}),
      });
      if (result.failed.length) {
        console.error('[presets] some embeddings failed:', result.failed);
      }
      return result;
    });
  },
);

/**
 * Feed a finalised estimate back into the preset library.
 *
 * Two durable steps so the paid half can retry without redoing the writes:
 * promote (DB only), then embed (network). Promotion is idempotent via
 * `sourceEstimateId`, so a retry of either step is safe.
 */
const promoteFn = inngest.createFunction(
  { id: 'estimate-promote', name: 'Promote finalised estimate to presets', retries: 2, triggers: [{ event: EVENT_PROMOTE }] },
  async ({ event, step }) => {
    const { estimateId } = event.data as PromoteEventData;

    const result = await step.run('promote', () => promoteEstimate(prisma, estimateId));

    // A preset the Archivist can't see is a preset that never matches, so the
    // embed is part of promoting — just a separately retried part of it.
    if (result.promoted.length > 0) {
      await step.run('embed-promoted', () =>
        backfillPresetEmbeddings(prisma, new EmbeddingProvider(createModelProvider()), {
          presetIds: result.promoted,
        }),
      );
    }

    return result;
  },
);

/**
 * The daily "what's due" sweep — the first cron function in this app; every
 * other one here is event-triggered.
 *
 * Runs at 09:00 Pakistan time so a nudge lands at the start of the working day
 * rather than overnight. The TZ prefix matters: without it Inngest reads the
 * expression as UTC and the mail arrives at 2pm local, which is the wrong half
 * of the day for "this is due today".
 *
 * One step, not one per estimate. The sweep is bounded (SWEEP_LIMIT) and each
 * iteration is a mail send plus a small write, so it fits inside the 300s a
 * single step gets; making each estimate its own step would buy nothing, since
 * the EstimateReminder rows already make a retry of the whole thing safe.
 *
 * `retries: 1` rather than 0 because the sweep is genuinely idempotent, and
 * rather than 2+ because a missed day is recovered by tomorrow's run anyway.
 */
const dueRemindersFn = inngest.createFunction(
  {
    id: 'estimate-due-reminders',
    name: 'Send estimate deadline reminders',
    retries: 1,
    triggers: [{ cron: 'TZ=Asia/Karachi 0 9 * * *' }],
  },
  async ({ step }) =>
    step.run('sweep-due-reminders', () =>
      sweepDueReminders(prisma, new Date(), sendDueReminderEmail),
    ),
);

/**
 * Generate one supporting document. AEH-239.
 *
 * Durable for a harder reason than the run's. The reference artifact is ~100KB,
 * roughly 25k output tokens, and Vercel Pro is ruled out — so the per-step
 * ceiling is a hard 300s with nothing behind it and one model call cannot
 * produce the document. Inngest invokes one `step.run()` per HTTP request, so
 * splitting into outline → one step per section → assemble gives each section
 * its own 300s. This is not an optimisation; it is the only reason the feature
 * is shippable on this deploy target.
 *
 * `concurrency: 2` is the other half of the budget. The plan allows 5 concurrent
 * runs account-wide, and an Inngest run holds its slot for its whole lifetime —
 * so a nine-section artifact occupies one for the ~10 minutes it takes. Three
 * people generating wireframe packs at once would leave two slots for estimate
 * runs, which are the core of the product. Capping here keeps three slots free
 * for runs, ingest, promote and embed no matter how many artifacts are queued:
 * artifacts wait, estimates never do.
 *
 * `retries: 1`, matching the run. Sections are upserted on
 * (artifactId, sectionId), so a retry re-does one section rather than the
 * document — but every attempt is a paid model call, so the appetite for them
 * is small.
 */
const artifactFn = inngest.createFunction(
  {
    id: 'estimate-artifact',
    name: 'Generate artifact',
    retries: 1,
    concurrency: 2,
    triggers: [{ event: EVENT_ARTIFACT }],
    onFailure: async ({ event, error }) => {
      const artifactId = (
        event as unknown as { data?: { event?: { data?: { artifactId?: string } } } }
      )?.data?.event?.data?.artifactId;
      if (!artifactId) return;
      // The sections already written are deliberately left in place. They are
      // what makes a retry cheap, and they are the difference between "failed
      // at section 7 of 9" and "start again".
      await prisma.estimateArtifact.update({
        where: { id: artifactId },
        data: {
          status: 'FAILED',
          stage: 'Failed',
          error: String(error?.message ?? error).slice(0, 500),
          finishedAt: new Date(),
        },
      });
    },
  },
  async ({ event, step }) => {
    const { artifactId } = event.data as ArtifactEventData;

    return runArtifact({
      db: prisma,
      artifactId,
      // Not `createModelProvider()` directly: the e2e run needs a deterministic
      // generator, and this is the seam that supplies one under OPENROUTER_STUB
      // without blanking the API key that ingest also uses.
      modelProvider: artifactModelProvider(),
      step: (id, fn) => step.run(id, fn) as ReturnType<typeof fn>,
      onProgress: async ({ stage, pct }) => {
        await prisma.estimateArtifact.update({
          where: { id: artifactId },
          data: { stage, pct },
        });
      },
    });
  },
);

export const inngestFunctions: InngestFunction.Any[] = [
  runEstimateFn,
  ingestFn,
  embedPresetsFn,
  promoteFn,
  dueRemindersFn,
  artifactFn,
];
