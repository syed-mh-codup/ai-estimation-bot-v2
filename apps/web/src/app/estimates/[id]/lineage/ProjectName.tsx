'use client';

import { useState, useTransition } from 'react';

import { renameProject } from '../lineage-actions';

/**
 * The project's name, editable in place. AEH-236.
 *
 * Mirrors `EstimateHeader`'s inline title exactly — same optimistic shape, same
 * commit-on-blur, same revert-and-say-why on failure — because it is the same
 * gesture one level up, and two spellings of "rename the thing at the top of
 * the page" would be two things to learn.
 *
 * A project is not a row anywhere: the name is denormalised across the family,
 * and this writes all of them. Which is why the failure path matters more than
 * it looks — a partial rename would leave a family disagreeing with itself
 * about what it is called, so anything short of success puts the old name back.
 */
export function ProjectName({
  estimateId,
  initialName,
}: {
  estimateId: string;
  initialName: string;
}) {
  const [name, setName] = useState(initialName);
  const [draft, setDraft] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const commit = (): void => {
    const next = draft.trim();
    if (!next || next === name) {
      setDraft(name);
      return;
    }
    const prev = name;
    setName(next);
    setError(null);
    startTransition(async () => {
      const out = await renameProject(estimateId, next);
      if (out.kind === 'refused') {
        setName(prev);
        setDraft(prev);
        setError(out.error);
      }
    });
  };

  return (
    <div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.currentTarget.value = name;
            setDraft(name);
            e.currentTarget.blur();
          }
        }}
        aria-label="Project name"
        maxLength={200}
        className="w-full rounded-[6px] border border-transparent bg-transparent font-serif text-[33px] leading-[1.15] font-medium tracking-[-0.015em] text-ink hover:border-line-soft focus:border-green focus:bg-surface focus:outline-none"
        data-testid="project-name"
      />
      {error && (
        <p className="mt-1 text-[12px] text-brick" data-testid="project-name-error">
          {error}
        </p>
      )}
    </div>
  );
}
