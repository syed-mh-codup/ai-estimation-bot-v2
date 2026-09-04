import type { z } from 'zod';
import type { UsageKind } from '@repo/db';
import type { ChatOptions, IModelProvider, TokenUsage } from '@repo/providers';
import type { UsageRecorder } from './usage-recorder';

export class LLMJsonError extends Error {
  constructor(
    public readonly agentLabel: string,
    message: string,
    public readonly raw: string,
  ) {
    super(`${agentLabel}: ${message}`);
    this.name = 'LLMJsonError';
  }
}

/**
 * Call the model in JSON mode and parse the result against `schema`.
 *
 * Deliberately throws instead of falling back to a stub value on a parse
 * failure — a silent `{baseHours: anchorHours, rationale: 'fallback'}` is
 * exactly what let the prompt/code drift go unnoticed for months (every
 * "fallback" looked like a legitimate low estimate). Callers that want
 * resilience should retry via `withRetry`, not swallow the error here.
 */
/**
 * Generic over the SCHEMA, not over its output type, and that is load-bearing.
 *
 * The obvious signature is `<T>(… schema: z.ZodType<T>) => Promise<T>`. It is
 * subtly wrong: a schema whose top-level fields carry `.default()` has an input
 * type that differs from its output type, and inference then resolves `T` to
 * the INPUT — so every defaulted field arrives at the call site as
 * possibly-undefined even though `parse` has just filled it in, and callers
 * either add non-null assertions or re-handle absence that cannot occur.
 *
 * `z.infer<S>` is the output type by definition, so this returns what `parse`
 * actually produced. Same z.input/z.infer trap the schema comments warn about
 * (it hid 47 typecheck errors once); this is the version of it that bites
 * consumers rather than fixtures.
 */
export async function chatJSON<S extends z.ZodTypeAny>(
  modelProvider: IModelProvider,
  options: Omit<ChatOptions, 'responseFormat'>,
  schema: S,
  agentLabel: string,
  attribution: { kind: UsageKind; recorder: UsageRecorder },
): Promise<z.infer<S>> {
  const result = await modelProvider.chat({ ...options, responseFormat: 'json_object' });
  // Record before parsing: a parse failure is still a real, billed model call.
  await attribution.recorder.record({
    kind: attribution.kind,
    model: result.model,
    usage: result.usage,
  });
  return parseLLMJson(result.text, schema, agentLabel);
}

/**
 * The raw text -> validated value step, shared by the buffered and streamed
 * callers so they cannot diverge on what counts as an acceptable response.
 */
function parseLLMJson<S extends z.ZodTypeAny>(
  raw: string,
  schema: S,
  agentLabel: string,
): z.infer<S> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Tolerate markdown-fenced JSON even in json_object mode (some models/
    // fallback routes still wrap it) before giving up.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new LLMJsonError(agentLabel, `model did not return JSON: ${raw.slice(0, 500)}`, raw);
    }
    try {
      json = JSON.parse(match[0]);
    } catch {
      throw new LLMJsonError(agentLabel, `model did not return valid JSON: ${raw.slice(0, 500)}`, raw);
    }
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new LLMJsonError(
      agentLabel,
      `response did not match schema: ${parsed.error.message}`,
      raw,
    );
  }
  return parsed.data;
}

/**
 * `chatJSON`, streamed, so a caller can report progress while it runs.
 *
 * Same discipline: record the spend before parsing (a parse failure is still a
 * billed call), validate against the schema, throw `LLMJsonError` with the raw
 * text rather than substituting a fallback value.
 *
 * The trade-off worth naming: `chatStream` does NOT fall back to another model
 * on error, where `chat` does — see the note on `IModelProvider`. So this buys
 * visibility at the cost of resilience, and it is the right trade only for work
 * a user is actively watching and can simply ask for again. Do not reach for it
 * inside a run.
 *
 * `onProgress` receives the text accumulated so far, not each delta, because
 * what callers want is a running read of the whole answer (how many items have
 * appeared) rather than the increments.
 */
export async function streamJSON<S extends z.ZodTypeAny>(
  modelProvider: IModelProvider,
  options: Omit<ChatOptions, 'responseFormat'>,
  schema: S,
  agentLabel: string,
  attribution: { kind: UsageKind; recorder: UsageRecorder },
  onProgress?: (accumulated: string) => void,
): Promise<z.infer<S>> {
  let raw = '';
  let usage: TokenUsage | null = null;
  let served = options.model;

  for await (const ev of modelProvider.chatStream({ ...options, responseFormat: 'json_object' })) {
    if (ev.type === 'delta') {
      raw += ev.text;
      onProgress?.(raw);
    } else {
      usage = ev.usage;
      served = ev.model;
    }
  }

  await attribution.recorder.record({ kind: attribution.kind, model: served, usage });
  return parseLLMJson(raw, schema, agentLabel);
}
