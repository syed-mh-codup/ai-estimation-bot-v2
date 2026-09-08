'use client';

import { useState } from 'react';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FieldLabel, Select } from '@/components/ui/input';
// Type-only, deliberately: `ModelChoice` and `toModelChoices` live on the
// server side of the boundary because a plain function exported from THIS
// module could not be called during a server render. See openrouter-models.ts.
import type { ModelChoice } from '@/lib/openrouter-models';

/**
 * The model picker and the two levers that decide whether the picked model can
 * actually finish, as one field group.
 *
 * They are one component rather than three because the reasoning control is
 * only meaningful for SOME models, and which model is selected lives in the
 * combobox's own state. Splitting them would mean either lifting that state
 * into every page that uses it or drawing a control that does nothing.
 *
 * Used by the crew prompt editor and by both artifact-type editors, which is
 * the whole point: an admin who can pick a model should be able to pick how it
 * is called, in the same place, without a deploy. AEH-322.
 */
const EFFORTS = ['low', 'medium', 'high'] as const;
const SORTS = ['throughput', 'latency', 'price'] as const;

const SORT_HINT: Record<(typeof SORTS)[number], string> = {
  throughput: 'fastest host — costs more per token',
  latency: 'quickest to start answering',
  price: 'cheapest host — OpenRouter’s default',
};

export function ModelCallFields({
  models,
  modelValue,
  reasoningEffort,
  providerSort,
  /**
   * Shown under the reasoning control. The two editors have genuinely different
   * things to say here — a crew prompt's reasoning changes the hours, an
   * artifact's changes the prose — so the caller supplies it.
   */
  reasoningNote,
  /**
   * Test id for the model picker. Defaulted rather than fixed because each
   * editor already had its own before these fields were one component, and
   * silently renaming someone's selector is not this change's business.
   */
  modelTestId = 'model-combobox',
}: {
  models: ModelChoice[];
  modelValue: string;
  reasoningEffort: string | null;
  providerSort: string | null;
  reasoningNote?: string;
  modelTestId?: string;
}) {
  const [model, setModel] = useState(modelValue);

  // A model absent from the catalogue (delisted, or the feed failed and this
  // degraded to free text) is treated as SUPPORTING reasoning, so that a value
  // an admin already saved stays visible and editable. Guessing the other way
  // would silently drop a working setting the first time OpenRouter had a bad
  // day — and an inert lever costs nothing, since the API ignores one it does
  // not understand.
  const known = models.find((m) => m.id === model);
  const supportsReasoning = known?.supportsReasoning ?? true;

  return (
    <div className="space-y-4">
      <div className="max-w-md">
        <FieldLabel htmlFor="modelString">Model</FieldLabel>
        <Combobox
          id="modelString"
          name="modelString"
          value={modelValue}
          onValueChange={setModel}
          options={models.map(
            (m): ComboboxOption => ({ value: m.id, label: m.label, hint: m.hint }),
          )}
          placeholder="Choose a model"
          emptyHint="Could not reach OpenRouter, so this is a plain text field. The value you type is saved as-is."
          data-testid={modelTestId}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor="providerSort">Route to</FieldLabel>
          {/* Not gated on the model. This is OpenRouter's routing rather than a
              model parameter, so it means something for every model — including
              one served by a single provider, where it still chooses between
              that provider's own endpoints. */}
          <Select
            id="providerSort"
            name="providerSort"
            defaultValue={providerSort ?? ''}
            className="w-full"
            data-testid="provider-sort"
          >
            <option value="">default (price)</option>
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {s} — {SORT_HINT[s]}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-[11.5px] text-ink-3">
            OpenRouter serves one model from several hosts at very different speeds and picks the
            cheapest unless told otherwise. Measured on the crew’s own model, routing for
            throughput halved the wall clock and changed nothing about the answer.
          </p>
        </div>

        <div>
          <FieldLabel htmlFor="reasoningEffort">Thinking effort</FieldLabel>
          {supportsReasoning ? (
            <>
              <Select
                id="reasoningEffort"
                name="reasoningEffort"
                defaultValue={reasoningEffort ?? ''}
                className="w-full"
                data-testid="reasoning-effort"
              >
                <option value="">model default</option>
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
              {/* There is no "off". Measured during AEH-321: the same call with
                  reasoning explicitly disabled hung for over nine minutes and
                  never returned. Down, never off. */}
              <p className="mt-1 text-[11.5px] text-ink-3">
                {reasoningNote ??
                  'Turning this down is the biggest lever on how long a call takes. There is deliberately no “off”.'}
              </p>
            </>
          ) : (
            // Absent, and SAID to be absent. A control that silently vanished
            // would read as a bug; worse, the API accepts an unsupported
            // reasoning field and ignores it, so without this line an admin
            // could reasonably believe the setting was doing something.
            <p
              className="rounded-md border border-line-soft bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink-3"
              data-testid="reasoning-unsupported"
            >
              <span className="num">{model || 'This model'}</span> does not offer a thinking
              setting, so there is nothing to tune. OpenRouter would accept the field and ignore
              it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
