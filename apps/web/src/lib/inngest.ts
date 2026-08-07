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

export type EstimateEventData = { estimateId: string };

/**
 * Refresh preset embeddings. Omit `presetIds` to sweep the whole library.
 * Embedding is a paid network call, so it never runs inline with the admin
 * save that triggers it.
 */
export type EmbedPresetsEventData = { presetIds?: string[] };
