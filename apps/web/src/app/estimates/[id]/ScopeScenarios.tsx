'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

import {
  deleteScenario,
  renameScenario,
  saveScenarioAs,
} from './scope-actions';
import type { ScenarioSummary } from './scope-dto';

/**
 * Saved configurations for one estimate. AEH-235.
 *
 * A configured scope is a record of a conversation the presales team had, so it
 * is worth keeping and worth handing to a colleague. Two things make that work:
 *
 *   - The selected configuration lives in the URL (`?scenario=…`), so the link
 *     in the address bar IS the configuration. Sharing needs no export, and
 *     re-opening it later needs no instructions.
 *   - Configurations are visible to everyone who can see the estimate, not just
 *     their author. Contrast Oracle threads, which are private because a
 *     half-finished line of questioning is not a deliverable; a cut of scope is.
 *
 * Saving COPIES the current selection rather than moving it, so the
 * configuration you were working in is left as it was. Somebody saving "Leanest
 * viable" halfway through exploring has not finished exploring.
 */
export function ScopeScenarios({
  estimateId,
  scenarios,
  currentId,
  currentPicks,
}: {
  estimateId: string;
  scenarios: ScenarioSummary[];
  currentId: string;
  /** What is selected right now — what "Save as" would capture. */
  currentPicks: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const current = scenarios.find((s) => s.id === currentId);

  /** Switching is a navigation, so the URL stays the shareable thing. */
  const open = (id: string) => {
    router.push(`/estimates/${estimateId}/scope?scenario=${id}`);
  };

  const save = () => {
    const name = draftName.trim();
    if (!name) {
      setError('Give the configuration a name.');
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const created = await saveScenarioAs(estimateId, name, currentPicks);
        setNaming(false);
        setDraftName('');
        // Straight into the new one, which is also what puts it in the URL.
        router.push(`/estimates/${estimateId}/scope?scenario=${created.id}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save that');
      }
    });
  };

  const rename = (name: string) => {
    if (!current || name.trim() === current.name) return;
    startTransition(async () => {
      try {
        await renameScenario(current.id, name);
        setError(null);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not rename that');
      }
    });
  };

  const remove = () => {
    if (!current) return;
    if (!window.confirm(`Delete "${current.name}"? The estimate itself is not affected.`)) return;
    startTransition(async () => {
      await deleteScenario(current.id);
      // Back to the default view, which re-resolves to whichever remains.
      router.push(`/estimates/${estimateId}/scope`);
    });
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is refused in some contexts; the URL is in the address
      // bar either way, so this is a convenience and not a failure worth
      // shouting about.
      setError('Could not copy — the link is in the address bar.');
    }
  };

  return (
    <div
      data-testid="scope-scenarios"
      className="rounded-[10px] border border-line bg-surface px-4 py-3.5"
    >
      <Eyebrow>Configurations</Eyebrow>

      {error && (
        <p data-testid="scope-scenario-error" className="mt-1.5 text-[11.5px] text-red">
          {error}
        </p>
      )}

      {/* The name of the one you are in, editable in place. */}
      {current && (
        <input
          key={current.id}
          defaultValue={current.name}
          onBlur={(e) => rename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          disabled={pending}
          aria-label="Configuration name"
          data-testid="scope-scenario-name"
          className="mt-2 w-full border-0 bg-transparent p-0 text-[13.5px] text-ink-1 focus:outline-none focus:ring-0"
        />
      )}
      {current && (
        <p className="mt-0.5 text-[11px] text-ink-4">
          {current.pickCount} picked · {current.author} ·{' '}
          {new Date(current.updatedAt).toLocaleDateString()}
        </p>
      )}

      {scenarios.length > 1 && (
        <ul className="mt-2.5 flex flex-col border-t border-line-soft pt-2">
          {scenarios
            .filter((s) => s.id !== currentId)
            .map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => open(s.id)}
                  disabled={pending}
                  data-testid={`scope-scenario-open-${s.id}`}
                  className="flex w-full items-baseline justify-between gap-2 py-1 text-left text-[12px] text-ink-3 hover:text-green"
                >
                  <span className="min-w-0 truncate">{s.name}</span>
                  <span className="num shrink-0 text-[10.5px] text-ink-4">
                    {s.pickCount} · {s.author}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      )}

      <div className="mt-2.5 flex flex-col gap-1.5 border-t border-line-soft pt-2">
        {naming ? (
          <div className="flex gap-1.5">
            <Input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') setNaming(false);
              }}
              placeholder="Leanest viable, Full platform…"
              aria-label="New configuration name"
              data-testid="scope-scenario-new-name"
            />
            <Button onClick={save} disabled={pending} data-testid="scope-scenario-save">
              Save
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            onClick={() => setNaming(true)}
            disabled={pending}
            data-testid="scope-scenario-save-as"
          >
            Save this as…
          </Button>
        )}

        <Button variant="ghost" onClick={copyLink} data-testid="scope-scenario-copy">
          {copied ? 'Link copied' : 'Copy link to share'}
        </Button>

        {scenarios.length > 1 && (
          <Button
            variant="ghost"
            onClick={remove}
            disabled={pending}
            data-testid="scope-scenario-delete"
          >
            Delete this one
          </Button>
        )}
      </div>
    </div>
  );
}
