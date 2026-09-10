'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { GitBranch, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { FieldLabel, Input, Textarea } from '@/components/ui/input';

type Kind = 'SUCCESSOR' | 'BRANCH';
type Phase = 'idle' | 'forking' | 'ingesting' | 'error';

/**
 * What each kind is for, in the estimator's words rather than the schema's.
 *
 * Both do the identical copy — the kind changes how tightly the reconciliation
 * holds to the parent's numbers, not what comes across. Saying so here is what
 * stops the choice reading as two different features.
 */
const KINDS: { value: Kind; label: string; blurb: string }[] = [
  {
    value: 'SUCCESSOR',
    label: 'Successor',
    blurb:
      'The client came back with revised requirements. This round holds to the last one and changes only what the new material forces.',
  },
  {
    value: 'BRANCH',
    label: 'Branch',
    blurb:
      'A different stack, or another route to the same outcome. The original hours are a reference to depart from where departing is right.',
  },
];

/**
 * Start a new estimate with this one as its reference. AEH-236.
 *
 * Both kinds take the same form, deliberately. Asking different questions for a
 * successor and a branch would imply the copy differs between them, and it does
 * not — every card, line, assumption and risk comes across either way.
 *
 * The documents are optional and the steering instruction is not decoration: on
 * a branch whose brief has not changed, that sentence is the only thing the
 * reconciliation has to go on.
 */
export function ForkDialog({
  estimateId,
  estimateTitle,
}: {
  estimateId: string;
  estimateTitle: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('SUCCESSOR');
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<{ stage: string; pct: number }>({ stage: '', pct: 0 });
  const [error, setError] = useState<string | null>(null);

  const busy = phase === 'forking' || phase === 'ingesting';

  /**
   * Poll the ingest exactly as the new-estimate form does. The fork lands
   * immediately; what takes time is reading whatever was attached, and the
   * fork is not worth opening until its brief is whole.
   */
  const pollIngest = useCallback(
    (id: string) => {
      const iv = setInterval(async () => {
        try {
          const res = await fetch(`/api/estimates/${id}/ingest-status`, { cache: 'no-store' });
          if (!res.ok) return;
          const d = await res.json();
          setProgress({ stage: d.ingestStage ?? 'Reading…', pct: d.ingestPct ?? 0 });
          if (d.ingestStatus === 'DONE') {
            clearInterval(iv);
            router.push(`/estimates/${id}`);
          } else if (d.ingestStatus === 'FAILED') {
            clearInterval(iv);
            setPhase('error');
            // The fork exists and holds the whole copied ledger — only the
            // attached documents failed. Say so, and point at it rather than
            // stranding somebody on a dialog for an estimate that was made.
            setError(
              `${d.ingestError ?? 'Could not read the attached documents.'} The fork itself was created — open it and add the material by hand.`,
            );
          }
        } catch {
          /* transient — the next tick retries */
        }
      }, 1500);
    },
    [router],
  );

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);
      const fd = new FormData(e.currentTarget);
      fd.delete('files');
      for (const f of files) fd.append('files', f);
      fd.set('kind', kind);

      if (!(fd.get('title') as string)?.trim()) {
        return setError('Give the new estimate a title.');
      }

      setPhase('forking');
      try {
        const res = await fetch(`/api/estimates/${estimateId}/fork`, {
          method: 'POST',
          body: fd,
        });
        const data = await res.json();
        if (!res.ok) {
          setPhase('error');
          return setError(data.error ?? 'Could not fork this estimate.');
        }
        if (data.ingesting) {
          setPhase('ingesting');
          setProgress({ stage: 'Queued', pct: 0 });
          pollIngest(data.id);
        } else {
          router.push(`/estimates/${data.id}`);
        }
      } catch {
        setPhase('error');
        setError('Could not reach the server. Nothing was created.');
      }
    },
    [estimateId, files, kind, pollIngest, router],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" full data-testid="open-fork">
          <GitBranch className="h-4 w-4" />
          Fork this estimate
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="fork-dialog">
        <DialogTitle>Fork this estimate</DialogTitle>
        <DialogDescription>
          Starts a new estimate with every card, line, assumption and flagged risk from{' '}
          <span className="font-medium text-ink">{estimateTitle}</span>. This one stays exactly as
          it is.
        </DialogDescription>

        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <fieldset disabled={busy} className="space-y-4">
            <div>
              <FieldLabel htmlFor="fork-title">Title</FieldLabel>
              <Input
                id="fork-title"
                name="title"
                required
                maxLength={200}
                defaultValue={`${estimateTitle} — `}
                data-testid="fork-title"
              />
            </div>

            <div>
              {/* A legend, not a FieldLabel: this labels a group of radios, and
                  pointing a <label htmlFor> at one of them would make clicking
                  the group's name select whichever came first. */}
              <legend className="eyebrow mb-1.5 block font-bold text-ink-3">Kind</legend>
              <div className="space-y-1.5">
                {KINDS.map((k) => (
                  <label
                    key={k.value}
                    className={`flex cursor-pointer gap-2.5 rounded-[7px] border px-3 py-2.5 transition-colors ${
                      kind === k.value
                        ? 'border-green-line bg-green-tint'
                        : 'border-line-soft hover:border-line'
                    }`}
                    data-testid={`fork-kind-${k.value.toLowerCase()}`}
                  >
                    <input
                      type="radio"
                      name="kind"
                      value={k.value}
                      checked={kind === k.value}
                      onChange={() => setKind(k.value)}
                      className="mt-0.5 accent-green"
                    />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-ink">{k.label}</span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-3">
                        {k.blurb}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <FieldLabel htmlFor="fork-steer">What&rsquo;s changing?</FieldLabel>
              <Textarea
                id="fork-steer"
                name="steer"
                rows={3}
                placeholder={
                  kind === 'BRANCH'
                    ? 'e.g. Same scope, but WordPress with plugins instead of a custom build.'
                    : 'e.g. Client dropped reporting, added a loyalty scheme, and now needs iOS.'
                }
                className="text-[13px] leading-relaxed"
                data-testid="fork-steer"
              />
              <p className="mt-1 text-[11.5px] leading-snug text-ink-4">
                {kind === 'BRANCH'
                  ? 'Worth writing carefully — with no new documents, this is the only thing describing what makes this cut different.'
                  : 'Read alongside anything you attach, when this fork is reconciled against what changed.'}
              </p>
            </div>

            <div>
              <FieldLabel htmlFor="fork-files">
                Revised material <span className="font-normal text-ink-4">(optional)</span>
              </FieldLabel>
              <input
                ref={fileRef}
                id="fork-files"
                name="files"
                type="file"
                multiple
                onChange={(e) => setFiles(Array.from(e.currentTarget.files ?? []))}
                className="block w-full text-[12px] text-ink-3 file:mr-3 file:rounded-[6px] file:border file:border-line file:bg-surface file:px-2.5 file:py-1 file:text-[12px] file:text-ink-2"
                data-testid="fork-files"
              />
              {files.length > 0 && (
                <ul className="mt-1.5 space-y-1" data-testid="fork-file-list">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-[11.5px] text-ink-3">
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setFiles((prev) => prev.filter((_, j) => j !== i));
                          if (fileRef.current) fileRef.current.value = '';
                        }}
                        aria-label={`Remove ${f.name}`}
                        className="shrink-0 text-ink-4 hover:text-brick"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-[11.5px] leading-snug text-ink-4">
                Added after the original brief, not instead of it — a change request only means
                something read against what it changes.
              </p>
            </div>
          </fieldset>

          {phase === 'ingesting' && (
            <div data-testid="fork-progress">
              <div className="flex items-baseline justify-between text-[11.5px] text-ink-3">
                <span>{progress.stage || 'Reading…'}</span>
                <span className="num">{progress.pct}%</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-line-soft">
                <div
                  className="h-full bg-green transition-[width] duration-500"
                  style={{ width: `${Math.max(2, progress.pct)}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <p className="text-[12px] leading-snug text-brick" data-testid="fork-error">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy} data-testid="submit-fork">
              {phase === 'forking' ? 'Copying…' : phase === 'ingesting' ? 'Reading…' : 'Fork'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
