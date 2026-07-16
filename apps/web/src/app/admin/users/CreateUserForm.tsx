'use client';

import { useActionState, useEffect, useRef } from 'react';

export type CreateUserState = { ok?: boolean; error?: string };

const initialState: CreateUserState = {};

/**
 * Admin "create user" form. Uses useActionState so validation errors (duplicate
 * email, weak password) render inline — the role-toggle forms on this page have
 * no error surface, so this is the one place that needs client state.
 */
export function CreateUserForm({
  action,
}: {
  action: (state: CreateUserState, formData: FormData) => Promise<CreateUserState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the fields after a successful create.
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="mt-6 rounded-md border border-gray-200 bg-white p-4"
      data-testid="create-user-form"
    >
      <h2 className="text-sm font-semibold text-gray-900">Add a user</h2>
      <p className="mt-0.5 text-xs text-gray-500">
        Sets an initial password the user can sign in with (they should change it).
      </p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="off"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
            data-testid="new-user-email"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Name <span className="font-normal text-gray-400">(optional)</span>
          <input
            name="name"
            type="text"
            autoComplete="off"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
            data-testid="new-user-name"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Temp password
          <input
            name="password"
            type="text"
            required
            minLength={8}
            autoComplete="off"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
            data-testid="new-user-password"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Role
          <select
            name="role"
            defaultValue="ESTIMATOR"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
            data-testid="new-user-role"
          >
            <option value="ESTIMATOR">ESTIMATOR</option>
            <option value="ADMIN">ADMIN</option>
          </select>
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          data-testid="create-user-submit"
        >
          {pending ? 'Creating…' : 'Create user'}
        </button>
        {state.error && (
          <span className="text-xs font-medium text-red-600" data-testid="create-user-error">
            {state.error}
          </span>
        )}
        {state.ok && (
          <span className="text-xs font-medium text-green-700" data-testid="create-user-success">
            User created.
          </span>
        )}
      </div>
    </form>
  );
}
