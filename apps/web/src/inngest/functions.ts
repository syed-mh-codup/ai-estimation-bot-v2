import { createHash } from 'node:crypto';
import { prisma } from '@repo/db';
import { createModelProvider } from '@repo/providers';
import type { InngestFunction } from 'inngest';
import { runEstimate, ingestFiles, type IngestFile } from '@repo/agents';
import { inngest, EVENT_RUN, EVENT_INGEST, type EstimateEventData } from '@/lib/inngest';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

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

    await step.run('run-pipeline', async () => {
      await runEstimate(estimateId, {
        db: prisma,
        modelProvider: createModelProvider(),
        onProgress: async ({ stage, pct }) => {
          await prisma.estimate.update({ where: { id: estimateId }, data: { runStage: stage, runPct: pct } });
        },
      });
    });

    await prisma.estimate.update({
      where: { id: estimateId },
      data: { runStatus: 'DONE', runStage: 'Done', runPct: 100, runFinishedAt: new Date() },
    });
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

      const { text } = await ingestFiles(files, {
        modelProvider: createModelProvider(),
        onProgress: async ({ stage, pct }) => {
          await prisma.estimate.update({ where: { id: estimateId }, data: { ingestStage: stage, ingestPct: pct } });
        },
      });

      const combined = [est.sowText, text].filter((s) => s.trim().length > 0).join('\n\n');
      await prisma.estimate.update({
        where: { id: estimateId },
        data: {
          sowText: combined,
          sowHash: sha(combined),
          ingestStatus: 'DONE',
          ingestStage: 'Done',
          ingestPct: 100,
        },
      });
      await prisma.uploadedFile.deleteMany({ where: { estimateId } });
      return { chars: combined.length };
    });

    return result;
  },
);

export const inngestFunctions: InngestFunction.Any[] = [runEstimateFn, ingestFn];
