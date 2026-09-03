'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { Select } from '@/components/ui/input';

/**
 * The artifacts card in the estimate rail. AEH-239.
 *
 * Deliberately the smallest thing that works: a picker, a button, and a line
 * per document. AEH-302 is already open about this rail being a fixed stack
 * that keeps growing and buries the actions, so anything richer belongs on the
 * artifact's own page, which is exactly where every row here links to.
 *
 * Polling rather than streaming, matching the run. Generation is a durable
 * Inngest job of N+2 steps, so there is real DB-backed state to read — and the
 * poll stops the moment nothing is running, because a rail card should not keep
 * a request in flight for an estimate nobody is generating anything from.
 */

type ArtifactRow = {
  id: string;
  title: string;
  typeName: string;
  status: 'IDLE' | 'RUNNING' | 'DONE' | 'FAILED';
  stage: string | null;
  pct: number;
  error: string | null;
  sectionsWritten: number;
};

export type ArtifactTypeOption = { key: string; name: string };

export function ArtifactsPanel({
  estimateId,
  types,
  initial,
}: {
  estimateId: string;
  types: ArtifactTypeOption[];
  initial: ArtifactRow[];
}) {
  const [rows, setRows] = useState<ArtifactRow[]>(initial);
  const [choice, setChoice] = useState(types[0]?.key ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const anyRunning = rows.some((r) => r.status === 'RUNNING' || r.status === 'IDLE');

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/estimates/${estimateId}/artifacts/status`);
      if (!res.ok) return;
      const data = (await res.json()) as { artifacts: ArtifactRow[] };
      setRows(data.artifacts);
    } catch {
      // A dropped poll is not worth reporting — the next tick recovers, and an
      // error banner that flickers on a flaky connection is worse than silence.
    }
  }, [estimateId]);

  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [anyRunning, refresh]);

  const generate = async (): Promise<void> => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/estimates/${estimateId}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifactTypeKey: choice }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Could not start generation.');
        return;
      }
      await refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="artifacts-panel">
      <CardBody>
        <Eyebrow>Artifacts</Eyebrow>

        {types.length === 0 ? (
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">
            No artifact types exist yet. An admin creates them under Artifacts — there are no
            built-in ones.
          </p>
        ) : (
          <div className="mt-2 flex gap-2">
            <Select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              aria-label="Artifact to generate"
              data-testid="artifact-type-select"
              className="min-w-0 flex-1"
            >
              {types.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              onClick={() => void generate()}
              disabled={busy}
              data-testid="generate-artifact"
            >
              {busy ? '…' : 'Generate'}
            </Button>
          </div>
        )}

        {error && (
          <p className="mt-2 text-[12px] text-brick" role="alert" data-testid="artifact-panel-error">
            {error}
          </p>
        )}

        {rows.length > 0 && (
          <ul className="mt-3 space-y-1.5 border-t border-line-soft pt-3">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2">
                <Link
                  href={`/estimates/${estimateId}/artifacts/${r.id}`}
                  className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2 hover:text-green hover:underline"
                  data-testid={`artifact-row-${r.id}`}
                >
                  {r.title}
                </Link>
                {r.status === 'DONE' && (
                  <Pill tone="green" dot={false}>
                    ready
                  </Pill>
                )}
                {r.status === 'FAILED' && (
                  <Pill tone="brick" dot={false}>
                    failed
                  </Pill>
                )}
                {(r.status === 'RUNNING' || r.status === 'IDLE') && (
                  // The written count, not the percentage. It is a real number
                  // somebody can check, and it is the one honest measure of how
                  // far along the slow part actually is.
                  <span className="num shrink-0 text-[11.5px] text-ink-3">
                    {r.sectionsWritten > 0 ? `${r.sectionsWritten} written` : (r.stage ?? 'queued')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
