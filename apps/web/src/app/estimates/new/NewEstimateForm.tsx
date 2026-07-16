'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldLabel, Input, Textarea } from '@/components/ui/input';

type Phase = 'idle' | 'submitting' | 'ingesting' | 'error';

const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,.png,.jpg,.jpeg,.webp,application/pdf,image/*';

/**
 * "Reading proposal.pdf (2/3)" → "Reading proposal.pdf" + "File 2 of 3".
 *
 * The ingest pipeline reports one free-text stage per file. There is no named
 * crew here — just documents — so the parenthetical count is the only part
 * worth lifting out of the label.
 */
function readIngestStage(stage: string): { label: string; detail: string | null } {
  const m = /^(.*?)\s*\((\d+)\/(\d+)\)\s*$/.exec(stage);
  if (!m) return { label: stage || 'Reading…', detail: null };
  return { label: m[1]!.trim(), detail: `File ${m[2]} of ${m[3]}` };
}

/**
 * Create an estimate from pasted text and/or uploaded client material. Files are
 * parsed in the background (vision/OCR for PDFs and images), and progress is
 * polled + reload-safe via the estimate's ingest status, so you always know
 * where the upload is before landing on the estimate.
 */
export function NewEstimateForm() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<{ stage: string; pct: number }>({ stage: '', pct: 0 });
  const [error, setError] = useState<string | null>(null);
  const [partialId, setPartialId] = useState<string | null>(null);

  const busy = phase === 'submitting' || phase === 'ingesting';

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
            setPartialId(id);
            setError(d.ingestError ?? 'Failed to read the uploaded files.');
          }
        } catch {
          /* transient — next tick retries */
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
      // Replace the native file list with our tracked one (handles re-selection).
      fd.delete('files');
      for (const f of files) fd.append('files', f);

      const title = (fd.get('title') as string)?.trim();
      const pasted = (fd.get('sowText') as string)?.trim();
      if (!title) return setError('Give the estimate a title before creating it.');
      if (!pasted && files.length === 0) {
        return setError('Paste a statement of work or attach at least one file.');
      }

      setPhase('submitting');
      try {
        const res = await fetch('/api/estimates/ingest-create', { method: 'POST', body: fd });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setPhase('error');
          return setError(d.error ?? `Could not create estimate (HTTP ${res.status})`);
        }
        const { id, ingesting } = await res.json();
        if (ingesting) {
          setPhase('ingesting');
          setProgress({ stage: 'Queued', pct: 0 });
          pollIngest(id);
        } else {
          router.push(`/estimates/${id}`);
        }
      } catch {
        setPhase('error');
        setError('Network error creating the estimate.');
      }
    },
    [files, pollIngest, router],
  );

  const { label, detail } = readIngestStage(progress.stage);

  return (
    <form onSubmit={onSubmit} className="mt-6 max-w-2xl">
      <div className="rounded-[10px] border border-line bg-surface p-5">
        <div>
          <FieldLabel htmlFor="title">Title</FieldLabel>
          <Input
            id="title"
            name="title"
            type="text"
            required
            disabled={busy}
            placeholder="e.g. Customer Loyalty Mobile App"
          />
        </div>

        <div className="mt-5">
          <FieldLabel htmlFor="files">Client material</FieldLabel>
          <p className="-mt-1 mb-2 text-[12.5px] leading-relaxed text-ink-3">
            PDF, Word (.docx), images (png/jpg/webp) or plain text. Diagrams, screenshots and
            scanned pages are read too.
          </p>
          <input
            id="files"
            ref={fileRef}
            name="files"
            type="file"
            multiple
            accept={ACCEPT}
            disabled={busy}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            data-testid="file-input"
            className="block w-full cursor-pointer rounded-md border border-dashed border-line bg-surface-2 p-2.5 text-[12.5px] text-ink-2 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-[12.5px] file:font-semibold file:text-ink-2 hover:border-green-line hover:file:border-ink-4 hover:file:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          />

          {files.length > 0 && (
            <ul
              className="mt-2.5 divide-y divide-line-soft rounded-md border border-line-soft bg-surface-2"
              data-testid="file-list"
            >
              {files.map((f) => (
                <li
                  key={f.name}
                  className="flex items-baseline justify-between gap-3 px-3 py-1.5 text-[12.5px]"
                >
                  <span className="truncate text-ink-2">{f.name}</span>
                  <span className="num shrink-0 text-[11.5px] text-ink-3">
                    {Math.ceil(f.size / 1024)} KB
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-5">
          <FieldLabel htmlFor="sowText">
            Statement of work{' '}
            <span className="font-normal text-ink-4">— optional if you attach files</span>
          </FieldLabel>
          <Textarea
            id="sowText"
            name="sowText"
            rows={10}
            disabled={busy}
            className="leading-relaxed"
            placeholder="Paste scope, features, integrations… or attach the BRD above."
          />
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button type="submit" disabled={busy} aria-busy={busy} data-testid="create-estimate-submit">
          {busy && (
            <span
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-surface/40 border-t-surface"
              aria-hidden
            />
          )}
          {phase === 'ingesting'
            ? 'Reading documents…'
            : phase === 'submitting'
              ? 'Creating…'
              : 'Create draft'}
        </Button>
        {!busy && (
          <span className="text-[12.5px] text-ink-3">
            You can run the estimate once the draft exists.
          </span>
        )}
      </div>

      {/* ── In flight: files are being read on the server. Bronze, determinate,
             and honest about where it is. ─────────────────────────────────── */}
      {phase === 'ingesting' && (
        <section
          className="mt-4 rounded-[10px] border border-bronze-line bg-[#FDFBF4] p-4"
          aria-live="polite"
          data-testid="ingest-progress"
        >
          <div className="flex flex-wrap items-start gap-3.5">
            <div className="min-w-[220px] flex-1">
              <div className="eyebrow">Reading your documents</div>
              {/* The count in the raw stage ("… (2/3)") is spelled out on the
                  detail line below, so the headline drops it. */}
              <div
                className="mt-1.5 truncate text-[14.5px] font-semibold text-ink"
                data-testid="ingest-stage"
              >
                {label}
              </div>
              <p className="mt-1 text-[12.5px] text-ink-3">
                {detail
                  ? `${detail} — text, tables and diagrams are pulled out of each page.`
                  : 'Text, tables and diagrams are pulled out of each page.'}
              </p>
            </div>

            <div className="num text-[26px] leading-none font-medium tracking-[-0.02em] text-bronze-ink">
              {progress.pct}
              <span className="text-[15px] text-bronze">%</span>
            </div>
          </div>

          <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className="relative h-full rounded-full bg-bronze transition-[width] duration-500 ease-out"
              style={{ width: `${Math.min(100, Math.max(3, progress.pct))}%` }}
            >
              <span className="absolute inset-0 animate-pulse rounded-full bg-bronze-tint/40" aria-hidden />
            </div>
          </div>

          <p className="mt-3.5 flex items-center gap-2 text-xs text-ink-3">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Safe to close this tab — the files are read on the server and progress is saved.
          </p>
        </section>
      )}

      {error && (
        <div
          data-testid="ingest-error"
          className="mt-4 rounded-[10px] border border-brick-line bg-brick-tint px-3.5 py-3"
          role="alert"
        >
          <div className="text-[13px] font-semibold text-brick">
            {partialId ? 'The files couldn’t be read' : 'The draft wasn’t created'}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed break-words text-ink-2">
            {error}
            {partialId && (
              <>
                {' '}
                The draft was saved with whatever was read before the failure.{' '}
                <a className="font-semibold text-brick underline" href={`/estimates/${partialId}`}>
                  Open the draft anyway
                </a>
                .
              </>
            )}
          </p>
        </div>
      )}
    </form>
  );
}
