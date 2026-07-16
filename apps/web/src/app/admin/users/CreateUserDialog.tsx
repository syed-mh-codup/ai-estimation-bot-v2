'use client';

import { useActionState, useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';

export type CreateUserState = { ok?: boolean; error?: string; emailed?: boolean };

const initialState: CreateUserState = {};

function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('');
}

/**
 * "Add user" as an explicit action: a button in the page header opens a modal
 * with the form, so the users table stays the primary content. Validation and
 * the created/emailed result render inline via useActionState.
 */
export function CreateUserDialog({
  action,
}: {
  action: (state: CreateUserState, formData: FormData) => Promise<CreateUserState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');

  // Close on success and reset the local field.
  useEffect(() => {
    if (state.ok) {
      setOpen(false);
      setPassword('');
    }
  }, [state.ok]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          data-testid="open-create-user"
        >
          <UserPlus className="h-4 w-4" />
          Add user
        </button>
      </DialogTrigger>
      <DialogContent data-testid="create-user-form">
        <DialogTitle>Add a user</DialogTitle>
        <DialogDescription>
          They can sign in right away with the temporary password. We&rsquo;ll email it to them.
        </DialogDescription>

        <form action={formAction} className="mt-4 space-y-3">
          <label className="block text-xs font-medium text-gray-600">
            Email
            <input
              name="email"
              type="email"
              required
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-300"
              data-testid="new-user-email"
            />
          </label>

          <label className="block text-xs font-medium text-gray-600">
            Name <span className="font-normal text-gray-400">(optional)</span>
            <input
              name="name"
              type="text"
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-300"
              data-testid="new-user-name"
            />
          </label>

          <label className="block text-xs font-medium text-gray-600">
            Temporary password
            <div className="mt-1 flex gap-2">
              <input
                name="password"
                type="text"
                required
                minLength={8}
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                data-testid="new-user-password"
              />
              <button
                type="button"
                onClick={() => setPassword(generatePassword())}
                className="shrink-0 rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                data-testid="generate-password"
              >
                Generate
              </button>
            </div>
          </label>

          <label className="block text-xs font-medium text-gray-600">
            Role
            <select
              name="role"
              defaultValue="ESTIMATOR"
              className="mt-1 w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-300"
              data-testid="new-user-role"
            >
              <option value="ESTIMATOR">Estimator</option>
              <option value="ADMIN">Admin</option>
            </select>
          </label>

          {state.error && (
            <p className="text-xs font-medium text-red-600" data-testid="create-user-error">
              {state.error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
              data-testid="create-user-submit"
            >
              {pending ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
