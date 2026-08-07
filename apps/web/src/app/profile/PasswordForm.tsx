'use client';

import { useActionState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input, FieldLabel } from '@/components/ui/input';

import type { PasswordState } from './actions';

const initialState: PasswordState = {};

export function PasswordForm({
  action,
  minLength,
}: {
  action: (state: PasswordState, formData: FormData) => Promise<PasswordState>;
  minLength: number;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the fields on success — three filled password boxes sitting there
  // afterwards look like the change didn't take.
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="mt-3.5 max-w-sm space-y-3">
      <div>
        <FieldLabel htmlFor="current-password">Current password</FieldLabel>
        <Input
          id="current-password"
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
          data-testid="current-password"
        />
      </div>
      <div>
        <FieldLabel htmlFor="new-password">New password</FieldLabel>
        <Input
          id="new-password"
          name="newPassword"
          type="password"
          required
          minLength={minLength}
          autoComplete="new-password"
          data-testid="new-password"
        />
      </div>
      <div>
        <FieldLabel htmlFor="confirm-password">Confirm new password</FieldLabel>
        <Input
          id="confirm-password"
          name="confirmPassword"
          type="password"
          required
          minLength={minLength}
          autoComplete="new-password"
          data-testid="confirm-password"
        />
      </div>

      {state.error && (
        <p
          className="rounded-md border border-brick-line bg-brick-tint px-3 py-2 text-[12.5px] font-medium text-brick"
          data-testid="password-error"
        >
          {state.error}
        </p>
      )}
      {state.ok && (
        <p
          className="rounded-md border border-green-line bg-green-tint px-3 py-2 text-[12.5px] font-medium text-green"
          data-testid="password-changed"
        >
          Password changed. Every device is signed out — use the new password to sign back in.
        </p>
      )}

      <Button type="submit" disabled={pending} data-testid="change-password-submit">
        {pending ? 'Changing…' : 'Change password'}
      </Button>
    </form>
  );
}
