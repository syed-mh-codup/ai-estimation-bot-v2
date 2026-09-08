'use client';

import { useState, useTransition } from 'react';

import { renameArtifact } from './actions';

/**
 * The document's name, inline-editable.
 *
 * Mirrors `EstimateHeader`'s title field deliberately — same optimistic commit
 * on blur, same Enter/Escape handling, same revert-and-explain on failure — so
 * that renaming a document works exactly like renaming the estimate it came
 * from, and neither has to be learned separately.
 *
 * Editable in every status, including while generating and after a failure. The
 * run no longer writes this column, so there is nothing to race: a name typed
 * mid-generation is the one the finished document assembles under.
 */
export function ArtifactTitle({
  artifactId,
  initialTitle,
}: {
  artifactId: string;
  initialTitle: string;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [draft, setDraft] = useState(initialTitle);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const commit = () => {
    const next = draft.trim();
    if (!next || next === title) {
      // Snap back rather than saving nothing: an emptied field left empty would
      // leave the masthead blank with nothing to click back into.
      setDraft(title);
      return;
    }
    const prev = title;
    setTitle(next);
    setError(null);
    startTransition(async () => {
      try {
        await renameArtifact(artifactId, next);
      } catch (e) {
        setTitle(prev);
        setDraft(prev);
        setError(e instanceof Error ? e.message : 'Could not rename');
      }
    });
  };

  return (
    <div className="min-w-0 flex-1 basis-[260px]">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(title);
            (e.target as HTMLInputElement).blur();
          }
        }}
        maxLength={200}
        aria-label="Document name"
        className="-ml-2 w-full rounded-md border border-transparent bg-transparent px-2 font-serif text-[33px] leading-[1.15] font-medium tracking-[-0.015em] text-ink hover:border-line focus:border-green focus:bg-surface focus:outline-none"
        data-testid="artifact-title-input"
      />
      {error && (
        <p className="mt-1 text-xs font-medium text-brick" data-testid="artifact-title-error">
          {error}
        </p>
      )}
    </div>
  );
}
