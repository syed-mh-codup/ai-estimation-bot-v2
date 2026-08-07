'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow } from '@/components/ui/card';
import { Input, Textarea, Select, FieldLabel } from '@/components/ui/input';

export type NewPresetState = { error?: string };

const initialState: NewPresetState = {};

const DATA_VOLUMES = ['NONE', 'LOW', 'HIGH'] as const;
const PHASES = ['FOUNDATION', 'CORE', 'ENHANCEMENT'] as const;
const LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;

/**
 * Creation asks only for what can't be sensibly defaulted, and specifically for
 * everything the Archivist matches on — name, description and keywords are the
 * text that becomes the preset's embedding, so a vague entry here is a preset
 * that never matches anything. The rest is refined in the editor afterwards.
 *
 * There is no ID or number field. The code is allocated server-side.
 */
export function NewPresetForm({
  action,
}: {
  action: (state: NewPresetState, formData: FormData) => Promise<NewPresetState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="mt-5 max-w-3xl">
      <Card>
        <CardBody className="space-y-4 p-4 sm:p-5">
          <div>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              name="name"
              required
              maxLength={200}
              placeholder="e.g. Company location selector UI"
              data-testid="new-preset-name"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel htmlFor="category">Category</FieldLabel>
              <Input
                id="category"
                name="category"
                required
                placeholder="e.g. B2B"
                data-testid="new-preset-category"
              />
            </div>
            <div>
              <FieldLabel htmlFor="reqType">Req. type</FieldLabel>
              <Input
                id="reqType"
                name="reqType"
                required
                placeholder="e.g. UI Component"
                data-testid="new-preset-reqtype"
              />
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="description">Description</FieldLabel>
            <Textarea
              id="description"
              name="description"
              rows={3}
              required
              placeholder="What this block of work covers. This text is what the Archivist matches requirements against."
              className="text-[13px] leading-relaxed"
              data-testid="new-preset-description"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel htmlFor="devHours">Dev hours</FieldLabel>
              <Input
                id="devHours"
                name="devHours"
                type="number"
                min={0}
                required
                defaultValue={0}
                className="num"
                data-testid="new-preset-devhours"
              />
              <p className="mt-1 text-[11.5px] text-ink-4">
                One combined figure — frontend and backend together.
              </p>
            </div>
            <div>
              <FieldLabel htmlFor="integrationCount">Integrations</FieldLabel>
              <Input
                id="integrationCount"
                name="integrationCount"
                type="number"
                min={0}
                defaultValue={0}
                className="num"
              />
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="keywords">Keywords (comma-separated)</FieldLabel>
            <Input
              id="keywords"
              name="keywords"
              placeholder="e.g. b2b, company location, pricing"
              data-testid="new-preset-keywords"
            />
            <p className="mt-1 text-[11.5px] text-ink-4">
              Matched against requirement text alongside the name and description.
            </p>
          </div>

          <div>
            <FieldLabel htmlFor="platforms">Platforms (comma-separated)</FieldLabel>
            <Input id="platforms" name="platforms" placeholder="e.g. Shopify, Contentful" />
          </div>

          <div className="border-t border-line-soft pt-4">
            <Eyebrow>Stack coverage</Eyebrow>
            <p className="mt-1 text-[11.5px] text-ink-4">
              For reference only — dev hours are estimated as one figure.
            </p>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
              <label className="flex items-center gap-2 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  name="touchesBackend"
                  defaultChecked
                  className="h-3.5 w-3.5 accent-[var(--color-green)]"
                  data-testid="new-preset-backend"
                />
                Backend
              </label>
              <label className="flex items-center gap-2 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  name="touchesFrontend"
                  className="h-3.5 w-3.5 accent-[var(--color-green)]"
                  data-testid="new-preset-frontend"
                />
                Frontend
              </label>
            </div>
          </div>

          <div className="grid gap-4 border-t border-line-soft pt-4 sm:grid-cols-3">
            <SelectField label="Data volume" name="dataVolume" options={DATA_VOLUMES} def="LOW" />
            <SelectField label="Phase" name="phase" options={PHASES} def="CORE" />
            <SelectField label="Risk" name="risk" options={LEVELS} def="LOW" />
          </div>
        </CardBody>
      </Card>

      {state.error && (
        <p
          className="mt-4 rounded-md border border-brick-line bg-brick-tint px-3 py-2 text-[12.5px] font-medium text-brick"
          data-testid="new-preset-error"
        >
          {state.error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button type="submit" size="lg" disabled={pending} data-testid="create-preset">
          {pending ? 'Creating…' : 'Create preset'}
        </Button>
        <span className="text-[12px] text-ink-4">
          You&rsquo;ll land on the editor to fill in the rest.
        </span>
      </div>
    </form>
  );
}

function SelectField({
  label,
  name,
  options,
  def,
}: {
  label: string;
  name: string;
  options: readonly string[];
  def: string;
}) {
  return (
    <div>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Select id={name} name={name} defaultValue={def} className="w-full py-2">
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    </div>
  );
}
