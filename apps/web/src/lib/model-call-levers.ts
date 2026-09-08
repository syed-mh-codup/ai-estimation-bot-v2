import type { ProviderSort, ReasoningEffort } from '@repo/db';
import { fetchModelOptions } from './openrouter-models';

/**
 * Read the two model-call levers off a submitted editor form.
 *
 * The database stores them UPPER_CASE, like every other enum in the schema;
 * OpenRouter wants them lowercase on the wire. This is the only place the two
 * spellings meet, and the form posts the wire spelling because the same strings
 * are what the API documents.
 *
 * The reasoning value is dropped when the chosen model does not advertise
 * support for it. That check is repeated here rather than trusted to the
 * editor, for two reasons: a form can post anything, and a model switch and a
 * lever arrive in the SAME submission — an admin who sets thinking to low on a
 * reasoning model and then, before saving, changes the model to one without it
 * would otherwise persist a setting that cannot ever apply. Storing null is
 * honest; storing `low` against a model that ignores it would show a value on
 * the version page that provably does nothing.
 *
 * Not enforced with `provider: { require_parameters: true }`, which is the
 * strict alternative OpenRouter offers. Measured against the live API: it turns
 * a call carrying an unsupported lever from a normal completion into
 * `No endpoints found that can handle the requested parameters`. Dropping the
 * value at save time prevents the same mistake without giving a stale row the
 * power to break a run.
 */
export async function readModelCallLevers(
  formData: FormData,
  modelString: string,
): Promise<{ reasoningEffort: ReasoningEffort | null; providerSort: ProviderSort | null }> {
  const providerSort = toProviderSortEnum(formData.get('providerSort'));
  const asked = toReasoningEffortEnum(formData.get('reasoningEffort'));
  if (!asked) return { reasoningEffort: null, providerSort };

  // Cached for an hour by `fetchModelOptions`, and an empty list means the
  // catalogue could not be reached. In that case KEEP what the admin asked
  // for: refusing to save a lever because a third party is down would be the
  // same trap the picker's free-text fallback exists to avoid, and the cost of
  // being wrong is a field the API ignores.
  const models = await fetchModelOptions();
  if (models.length === 0) return { reasoningEffort: asked, providerSort };

  const chosen = models.find((m) => m.id === modelString);
  // A model absent from the catalogue is treated the same way: not proof it
  // lacks the setting, only that this list has not heard of it.
  if (!chosen) return { reasoningEffort: asked, providerSort };

  return { reasoningEffort: chosen.supportsReasoning ? asked : null, providerSort };
}

/** Form value ('low') -> stored enum ('LOW'). Anything else is null. */
function toReasoningEffortEnum(value: FormDataEntryValue | null): ReasoningEffort | null {
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'low':
      return 'LOW';
    case 'medium':
      return 'MEDIUM';
    case 'high':
      return 'HIGH';
    // Deliberately no case for an off switch: AEH-321 measured reasoning
    // explicitly disabled hanging for over nine minutes. Down, never off.
    default:
      return null;
  }
}

/** Form value ('throughput') -> stored enum ('THROUGHPUT'). Anything else is null. */
function toProviderSortEnum(value: FormDataEntryValue | null): ProviderSort | null {
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'throughput':
      return 'THROUGHPUT';
    case 'latency':
      return 'LATENCY';
    case 'price':
      return 'PRICE';
    default:
      return null;
  }
}

/** Stored enum ('LOW') -> the form/wire spelling ('low'), for rendering. */
export function leverToFormValue(value: string | null | undefined): string | null {
  return value ? value.toLowerCase() : null;
}
