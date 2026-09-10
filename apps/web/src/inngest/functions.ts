import { prisma } from '@repo/db';
import { createModelProvider, EmbeddingProvider } from '@repo/providers';
import type { InngestFunction } from 'inngest';
import { runEstimate, ingestFiles, backfillPresetEmbeddings, promoteEstimate, createUsageRecorder, runArtifact, runLedgerEdit, runReconciliation, type IngestFile } from '@repo/agents';
import {
  inngest,
  EVENT_RUN,
  EVENT_INGEST,
  EVENT_EMBED_PRESETS,
  EVENT_PROMOTE,
  EVENT_ARTIFACT,
  EVENT_ARTIFACT_CANCEL,
  EVENT_LEDGER_EDIT,
  EVENT_RECONCILE,
  type EstimateEventData,
  type EmbedPresetsEventData,
  type PromoteEventData,
  type ArtifactEventData,
  type LedgerEditEventData,
  type ReconcileEventData,
} from '@/lib/inngest';
import { sendDueReminderEmail, sendIngestCompleteEmail, sendRunCompleteEmail } from '@/lib/email';
import { sweepDueReminders } from '@/lib/reminders';
import { artifactModelProvider } from '@/lib/artifact-provider';
import { taxContextForEstimate } from '@/lib/estimate-tax';


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
      // Ordered, deliberately. The SOW is assembled by concatenating these in
      // sequence, so this `orderBy` is the only thing deciding what the model
      // reads first — and without it the read was unordered and the answer was
      // whatever Postgres felt like. `filename` breaks a tie so that rows
      // sharing a position (every row predating the column) still assemble the
      // same way twice rather than differing between attempts of one ingest.
      const rows = await prisma.uploadedFile.findMany({
        where: { estimateId },
        orderBy: [{ order: 'asc' }, { filename: 'asc' }],
      });
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
    // Stop a generation from the UI. AEH-321.
    //
    // `match` pins the cancelling event to THIS artifact — without it one Stop
    // would cancel every generation in flight.
    //
    // Inngest cancels BETWEEN steps: a section already talking to the model
    // finishes first, so a click lands within about a section, not instantly.
    // That is also why nothing is lost — the section that was in flight is
    // still written, and the row stays resumable.
    cancelOn: [{ event: EVENT_ARTIFACT_CANCEL, match: 'data.artifactId' }],
    onFailure: async ({ event, error }) => {
      const artifactId = (
        event as unknown as { data?: { event?: { data?: { artifactId?: string } } } }
      )?.data?.event?.data?.artifactId;
      if (!artifactId) return;
      // The sections already written are deliberately left in place. They are
      // what makes a retry cheap, and they are the difference between "failed
      // at section 7 of 9" and "start again".
      // `updateMany` with a status guard, not `update`. A cancelled run settles
      // its own row before the event goes out, and if Inngest also reports that
      // as a failure this would overwrite "Stopped from the app" with a generic
      // cancellation error — replacing the one explanation a person can act on
      // with one they cannot. Only a row still marked RUNNING is ours to fail.
      await prisma.estimateArtifact.updateMany({
        where: { id: artifactId, status: 'RUNNING' },
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


/**
 * A steered edit to part of the ledger. AEH-238.
 *
 * One `step.run` per card per role, for the same reason the artifact function
 * splits by section: Inngest invokes one step per HTTP request, so each slice
 * gets its own 300s rather than the whole envelope sharing one. A person
 * re-pricing DEV across six cards is six calls, and six calls do not fit in one
 * invocation.
 *
 * `concurrency: 2`, matching artifacts and for the same budget reason. The plan
 * allows 5 concurrent runs account-wide and a run holds its slot for its whole
 * lifetime, so editing must never be able to starve the estimate runs that are
 * the core of the product. Edits wait; runs never do.
 *
 * `retries: 1`, also matching. A replayed step re-reads the row and re-prices
 * the same slice, which is safe — but every attempt is a paid model call.
 */
const ledgerEditFn = inngest.createFunction(
  {
    id: 'estimate-ledger-edit',
    name: 'Steered ledger edit',
    retries: 1,
    concurrency: 2,
    triggers: [{ event: EVENT_LEDGER_EDIT }],
    onFailure: async ({ event, error }) => {
      const editId = (event as unknown as { data?: { event?: { data?: { editId?: string } } } })
        ?.data?.event?.data?.editId;
      if (!editId) return;
      // A real FAILED state rather than a stuck RUNNING. On this deploy a step
      // that overruns dies as a bare HTTP 504 with no step output, so without
      // this the ledger would poll a spinner for ever — which is worse than the
      // blocking call the job replaced.
      //
      // Guarded on RUNNING/QUEUED: an edit that already settled itself (refused
      // for a lock, or parked as a conflict) owns its own explanation, and this
      // must not overwrite a sentence someone can act on with a generic one.
      await prisma.ledgerEdit.updateMany({
        where: { id: editId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status: 'FAILED',
          stage: 'Failed',
          error: String(error?.message ?? error).slice(0, 500),
        },
      });
    },
  },
  async ({ event, step }) => {
    const { editId } = event.data as LedgerEditEventData;

    const edit = await step.run('claim-edit', async () => {
      const row = await prisma.ledgerEdit.findUniqueOrThrow({
        where: { id: editId },
        select: { estimateId: true },
      });
      await prisma.ledgerEdit.update({
        where: { id: editId },
        data: { status: 'RUNNING', stage: 'Starting', pct: 1, error: null },
      });
      return row;
    });

    // The buffers in force for the estimate's PINNED config version, resolved
    // here and passed down. The engine deliberately does not look them up: that
    // would be a second place deciding which config version applies, and
    // AEH-335 exists because that decision was once made in the wrong one.
    const { effective } = await taxContextForEstimate(edit.estimateId);

    return runLedgerEdit(editId, {
      db: prisma,
      modelProvider: createModelProvider(),
      effective,
      step: (id, fn) => step.run(id, fn) as ReturnType<typeof fn>,
      onProgress: async ({ stage, pct }) => {
        await prisma.ledgerEdit.update({ where: { id: editId }, data: { stage, pct } });
      },
    });
  },
);

/**
 * The reconciliation pass. AEH-236.
 *
 * Mirrors the steered edit deliberately: same claim-then-run shape, same
 * `onFailure` writing a real FAILED state, same pinned-config buffers resolved
 * here and passed down rather than looked up twice.
 *
 * `concurrency: 1`, where the edit allows 2. A pass can put every card on a
 * large estimate in play, so two at once is a different order of spend from two
 * steered edits — and unlike an edit, running two reconciliations against one
 * estimate produces two competing answers to the same question.
 */
const reconcileFn = inngest.createFunction(
  {
    id: 'estimate-reconcile',
    name: 'Reconcile a forked estimate',
    retries: 1,
    concurrency: 1,
    triggers: [{ event: EVENT_RECONCILE }],
    onFailure: async ({ event, error }) => {
      const reconciliationId = (
        event as unknown as { data?: { event?: { data?: { reconciliationId?: string } } } }
      )?.data?.event?.data?.reconciliationId;
      if (!reconciliationId) return;
      // A real FAILED state rather than a stuck RUNNING: an overrunning step
      // dies as a bare 504 with no step output on this deploy, and the review
      // would otherwise poll a spinner for ever. Guarded on QUEUED/RUNNING so a
      // pass that already settled keeps its own explanation.
      await prisma.estimateReconciliation.updateMany({
        where: { id: reconciliationId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status: 'FAILED',
          stage: 'Failed',
          error: String(error?.message ?? error).slice(0, 500),
        },
      });
    },
  },
  async ({ event, step }) => {
    const { reconciliationId } = event.data as ReconcileEventData;

    const rec = await step.run('claim-reconciliation', async () => {
      const row = await prisma.estimateReconciliation.findUniqueOrThrow({
        where: { id: reconciliationId },
        select: { estimateId: true },
      });
      await prisma.estimateReconciliation.update({
        where: { id: reconciliationId },
        data: { status: 'RUNNING', stage: 'Starting', pct: 1, error: null },
      });
      return row;
    });

    const { effective } = await taxContextForEstimate(rec.estimateId);

    return runReconciliation(reconciliationId, {
      db: prisma,
      modelProvider: createModelProvider(),
      effective,
      step: (id, fn) => step.run(id, fn) as ReturnType<typeof fn>,
    });
  },
);

export const inngestFunctions: InngestFunction.Any[] = [
  runEstimateFn,
  ingestFn,
  embedPresetsFn,
  promoteFn,
  ledgerEditFn,
  reconcileFn,
  dueRemindersFn,
  artifactFn,
];
