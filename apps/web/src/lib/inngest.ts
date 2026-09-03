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
