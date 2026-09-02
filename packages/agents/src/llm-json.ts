import type { z } from 'zod';
import type { UsageKind } from '@repo/db';
import type { ChatMessage, IModelProvider } from '@repo/providers';
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
  options: { model: string; messages: ChatMessage[]; temperature?: number },
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
  const raw = result.text;

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
