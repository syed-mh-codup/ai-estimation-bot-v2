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
export async function chatJSON<T>(
  modelProvider: IModelProvider,
  options: { model: string; messages: ChatMessage[]; temperature?: number },
  schema: z.ZodType<T>,
  agentLabel: string,
  attribution: { kind: UsageKind; recorder: UsageRecorder },
): Promise<T> {
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
