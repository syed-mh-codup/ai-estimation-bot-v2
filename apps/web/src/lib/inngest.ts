import { Inngest } from 'inngest';

/**
 * Inngest client. On serverless, the estimate run + document ingestion can't be
 * detached promises (they die when the function returns), so they run as durable
 * Inngest functions instead. Event/signing keys are read from env in production;
 * local dev uses the Inngest dev server (`npx inngest-cli@latest dev`).
 */
export const inngest = new Inngest({ id: 'codup-ai-estimation' });

export const EVENT_RUN = 'estimate/run.requested' as const;
export const EVENT_INGEST = 'estimate/ingest.requested' as const;
export const EVENT_EMBED_PRESETS = 'preset/embed.requested' as const;
export const EVENT_PROMOTE = 'estimate/finalised' as const;
export const EVENT_ARTIFACT = 'estimate/artifact.requested' as const;
/**
 * Stop a generation that is already running. AEH-321.
 *
 * A separate event rather than a flag on the row, because Inngest cancels a run
 * by matching an event against the one that started it — see `cancelOn` on
 * `artifactFn`. A row flag would only be noticed by code that thought to look,
 * and the whole problem is that the expensive part is a model call nobody is
 * polling anything from.
 */
export const EVENT_ARTIFACT_CANCEL = 'estimate/artifact.cancelled' as const;
/**
 * A steered edit to part of an estimate's ledger. AEH-238.
 *
 * A job rather than a request, and the reason is written down in the Oracle
 * route: everything that takes time here is an Inngest function the client
 * polls. Oracle streams because watching the words appear IS the value there;
 * an edit's value is the result, and re-pricing a wide envelope is one model
 * call per card per role — which does not fit in a single 300s invocation and
 * should not try to.
 */
export const EVENT_LEDGER_EDIT = 'estimate/ledger-edit.requested' as const;
/** A forked estimate is being reconciled against what changed. AEH-236. */
export const EVENT_RECONCILE = 'estimate/reconcile.requested' as const;

export type EstimateEventData = { estimateId: string; runId?: string };

/**
 * Refresh preset embeddings. Omit `presetIds` to sweep the whole library.
 * Embedding is a paid network call, so it never runs inline with the admin
 * save that triggers it.
 */
export type EmbedPresetsEventData = { presetIds?: string[] };

/**
 * A finalised estimate is ready to feed the preset library. Out of band because
 * promotion writes many rows and then spends money embedding them — finalising
 * must stay fast, and the write-back must be able to retry on its own.
 */
export type PromoteEventData = { estimateId: string };

/**
 * Generate one supporting document. AEH-239.
 *
 * The row is created by the route BEFORE this fires, so `artifactId` always
 * names something that exists: generation needs an id to attribute spend to and
 * a row to report progress on from its very first step, and there is nowhere
 * else to put either.
 */
export type ArtifactEventData = { artifactId: string };

/** The `LedgerEdit` row to carry out. Everything else is read from it. */
export type LedgerEditEventData = { editId: string };
export type ReconcileEventData = { reconciliationId: string };
