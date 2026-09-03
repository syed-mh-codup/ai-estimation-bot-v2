'use client';

import type React from 'react';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Input, Textarea, FieldLabel } from '@/components/ui/input';

export type NewArtifactTypeState = { error?: string };

const initialState: NewArtifactTypeState = {};

/**
 * The create form. AEH-239.
 *
 * `corpusSlot` takes the picker as a child rather than importing it, because
 * the picker is a server component reading the corpus catalogue out of
 * `@repo/db` — importing that from a client bundle would drag Prisma in with
 * it. Passing it through as a slot keeps the checkboxes inside this form
 * element, which is all the form actually needs from it.
 *
 * The brief gets the biggest field on the screen on purpose. It is the whole
 * specification of the document: there is no template behind it supplying a
 * shape, so whatever is not written here does not happen.
 */
export function NewArtifactTypeForm({
  action,
  modelOptions,
  corpusSlot,
}: {
  action: (
    state: NewArtifactTypeState,
    formData: FormData,
  ) => Promise<NewArtifactTypeState>;
  modelOptions: { value: string; label: string; hint?: string }[];
  corpusSlot: React.ReactNode;
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
              maxLength={120}
              placeholder="e.g. Entity model"
              data-testid="new-artifact-name"
            />
            <p className="mt-1 text-[12px] text-ink-4">
              Shown wherever someone picks an artifact to generate. The URL handle is derived from
              it.
            </p>
          </div>

          <div>
            <FieldLabel htmlFor="description">Description</FieldLabel>
            <Input
              id="description"
              name="description"
              maxLength={300}
              placeholder="e.g. Every logical entity in the system and how they relate"
              data-testid="new-artifact-description"
            />
            <p className="mt-1 text-[12px] text-ink-4">
              One line, for whoever is choosing. Optional.
            </p>
          </div>

          <div className="max-w-md">
            <FieldLabel htmlFor="modelString">Model</FieldLabel>
            <Combobox
              id="modelString"
              name="modelString"
              // Empty rather than a hardcoded default. Picking the model is a
              // cost decision per artifact type — a wireframe pack is many more
              // calls than an ERD — so it is asked, not assumed.
              value=""
              options={modelOptions}
              placeholder="Choose a model"
              emptyHint="Could not reach OpenRouter, so this is a plain text field. The value you type is saved as-is."
              data-testid="new-artifact-model"
            />
            <p className="mt-1 text-[12px] text-ink-4">
              Generation is one call per section, so this is charged several times per document.
            </p>
          </div>
        </CardBody>
      </Card>

      <Card className="mt-3.5">
        <CardBody className="p-4 sm:p-5">{corpusSlot}</CardBody>
      </Card>

      <Card className="mt-3.5">
        <CardBody className="p-4 sm:p-5">
          <FieldLabel htmlFor="promptBody">The brief</FieldLabel>
          <p className="mt-1 mb-2 text-[12.5px] leading-relaxed text-ink-3">
            What this document is and what it must show. Write it as an instruction to somebody
            who has the estimate in front of them and has never seen your product.
          </p>
          <p className="mb-2.5 text-[12.5px] leading-relaxed text-ink-3">
            Do not describe HTML, tabs, styling or file structure. The page, its navigation and its
            styling are supplied around whatever you ask for — your brief decides the content, and
            the machinery decides the container. Say what the document must contain, how it should
            be organised, and what a reader should be able to work out from it.
          </p>
          <Textarea
            id="promptBody"
            name="promptBody"
            rows={16}
            required
            placeholder={
              'e.g. Produce the entity model implied by this scope.\n\nCover every logical entity the system needs, grouped by domain. For each, give its purpose in one line, its key attributes, and its relationships to other entities with cardinality. Where an entity only becomes necessary because of a particular part of the scope, say which.'
            }
            className="font-mono text-[12.5px] leading-relaxed"
            data-testid="new-artifact-brief"
          />
        </CardBody>
      </Card>

      {state.error && (
        <p
          className="mt-3.5 rounded-md border border-brick-line bg-brick-tint px-3 py-2 text-[12.5px] text-brick"
          role="alert"
          data-testid="new-artifact-error"
        >
          {state.error}
        </p>
      )}

      <div className="mt-4">
        <Button type="submit" disabled={pending} data-testid="create-artifact-type">
          {pending ? 'Creating…' : 'Create artifact type'}
        </Button>
      </div>
    </form>
  );
}
