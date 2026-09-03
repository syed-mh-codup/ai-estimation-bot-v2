'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

/**
 * Pick a failed generation up where it stopped. AEH-239.
 *
 * Sections are written to their own rows as they land specifically so a failure
 * part-way keeps them, and this is the control that makes that worth anything.
 * Pressing Generate again on the estimate would start a NEW document and pay
 * for every section a second time; this re-runs the same one and only fills in
 * what is missing.
 */
export function ResumeButton({
  estimateId,
  artifactId,
  written,
  planned,
}: {
  estimateId: string;
  artifactId: string;
  written: number;
  planned: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remaining = planned > 0 ? planned - written : null;

  const resume = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/estimates/${estimateId}/artifacts/${artifactId}/resume`,
        { method: 'POST' },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Could not resume.');
        return;
      }
      // Re-fetch so the page swaps the failure card for the live progress view.
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3.5">
      <Button type="button" onClick={() => void resume()} disabled={busy} data-testid="resume-artifact">
        {busy ? 'Resuming…' : 'Resume generation'}
      </Button>
      <p className="mt-1.5 text-[11.5px] text-ink-4">
        {remaining !== null && remaining > 0
          ? `Picks up from the existing plan — ${remaining} of ${planned} ${
              remaining === 1 ? 'section' : 'sections'
            } left to write. Nothing already written is paid for again.`
          : 'Picks up from the existing plan. Nothing already written is paid for again.'}
      </p>
      {error && (
        <p className="mt-1.5 text-[12px] text-brick" role="alert" data-testid="resume-error">
          {error}
        </p>
      )}
    </div>
  );
}
