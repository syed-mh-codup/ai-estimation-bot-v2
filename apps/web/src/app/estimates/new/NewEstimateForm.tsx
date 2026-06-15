'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Phase = 'idle' | 'submitting' | 'ingesting' | 'error';

const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,.png,.jpg,.jpeg,.webp,application/pdf,image/*';

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
      if (!title) return setError('Title is required.');
      if (!pasted && files.length === 0) {
        return setError('Paste a Statement of Work or upload at least one file.');
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

  return (
    <form onSubmit={onSubmit} className="mt-6 max-w-2xl space-y-4">
      <div>
        <label htmlFor="title" className="block text-sm font-medium text-gray-700">
          Title
        </label>
        <input
          id="title"
          name="title"
          type="text"
          required
          disabled={busy}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none disabled:opacity-60"
          placeholder="e.g. Customer Loyalty Mobile App"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">Client material</label>
        <p className="text-xs text-gray-500">
          PDF, Word (.docx), images (png/jpg/webp), or text. Diagrams, screenshots and scanned pages
          are read too.
        </p>
        <input
          ref={fileRef}
          name="files"
          type="file"
          multiple
          accept={ACCEPT}
          disabled={busy}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          data-testid="file-input"
          className="mt-1 block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-gray-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-gray-700 disabled:opacity-60"
        />
        {files.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-gray-600" data-testid="file-list">
            {files.map((f) => (
              <li key={f.name}>
                • {f.name} <span className="text-gray-400">({Math.ceil(f.size / 1024)} KB)</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <label htmlFor="sowText" className="block text-sm font-medium text-gray-700">
          Statement of Work <span className="font-normal text-gray-400">(optional if files attached)</span>
        </label>
        <textarea
          id="sowText"
          name="sowText"
          rows={10}
          disabled={busy}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none disabled:opacity-60"
          placeholder="Paste scope, features, integrations… or upload the BRD above."
        />
      </div>

      <button
        type="submit"
        disabled={busy}
        data-testid="create-estimate-submit"
        className="inline-flex items-center gap-2 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy && (
          <span
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
            aria-hidden
          />
        )}
        {phase === 'ingesting' ? 'Reading documents…' : phase === 'submitting' ? 'Creating…' : 'Create draft'}
      </button>

      {phase === 'ingesting' && (
        <div className="max-w-md" data-testid="ingest-progress">
          <div className="flex items-center justify-between text-xs text-gray-600">
            <span data-testid="ingest-stage">{progress.stage}</span>
            <span>{progress.pct}%</span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-gray-200">
            <div
              className="h-full rounded-full bg-gray-900 transition-[width] duration-500 ease-out"
              style={{ width: `${Math.min(100, Math.max(3, progress.pct))}%` }}
            />
          </div>
        </div>
      )}

      {phase === 'error' && error && (
        <div
          data-testid="ingest-error"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <span className="font-medium">Error:</span> {error}
          {partialId && (
            <>
              {' '}
              <a className="underline" href={`/estimates/${partialId}`}>
                Open the draft anyway
              </a>
              .
            </>
          )}
        </div>
      )}
    </form>
  );
}
