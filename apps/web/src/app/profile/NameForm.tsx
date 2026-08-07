'use client';

import { useActionState, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, FieldLabel } from '@/components/ui/input';

import type { NameState } from './actions';

const initialState: NameState = {};

export function NameForm({
  action,
  initialName,
}: {
  action: (state: NameState, formData: FormData) => Promise<NameState>;
  initialName: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState(false);

  // Confirmation that fades. A permanent "Saved" next to a field you might
  // edit again reads as stale the moment you touch it.
  useEffect(() => {
    if (!state.ok) return;
    setSaved(true);
    const t = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <form action={formAction} className="mt-3.5">
      <FieldLabel htmlFor="profile-name">Display name</FieldLabel>
      <div className="flex flex-wrap items-start gap-2">
        <Input
          id="profile-name"
          name="name"
          type="text"
          maxLength={120}
          autoComplete="name"
          placeholder="e.g. Alex Whitfield"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-[200px] flex-1"
          data-testid="profile-name-input"
        />
        <Button
          type="submit"
          disabled={pending || name.trim() === initialName.trim()}
          data-testid="profile-name-save"
        >
          {pending ? 'Saving…' : 'Save name'}
        </Button>
      </div>

      {state.error && (
        <p
          className="mt-2 rounded-md border border-brick-line bg-brick-tint px-3 py-2 text-[12.5px] font-medium text-brick"
          data-testid="profile-name-error"
        >
          {state.error}
        </p>
      )}
      {saved && !state.error && (
        <p className="mt-2 text-[12.5px] font-medium text-green" data-testid="profile-name-saved">
          Name updated.
        </p>
      )}
    </form>
  );
}
