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
  const [plan, setPlan] = useState<{
    title: string;
    sections: string[];
    /** Ticked sections this estimate has no data for. */
    empty: { key: string; label: string }[];
    /** Ticked keys this build no longer knows about. */
    retired: string[];
  } | null>(null);
  /**
   * Which slow thing is in flight. `busy` alone was not enough: the preview
   * link and the Generate button share it, so a preview left the link merely
   * faded with its text unchanged, which reads as a dead button for however
   * long the model takes.
   */
  const [pending, setPending] = useState<'none' | 'preview' | 'generate'>('none');

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

  /**
   * Plan the document without generating it.
   *
   * One model call against nine, and the difference between tuning a brief in a
   * minute and tuning it in ten. It earns its place specifically because nothing
   * is seeded: every artifact type here was written from scratch, so somebody is
   * always iterating on one.
   */
  const preview = async (): Promise<void> => {
    if (!choice) return;
    setBusy(true);
    setPending('preview');
    setError(null);
    setPlan(null);
    try {
      const res = await fetch(`/api/estimates/${estimateId}/artifacts/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifactTypeKey: choice }),
      });
      const data = (await res.json()) as {
        error?: string;
        outline?: { title: string; sections: { title: string }[] };
        empty?: { key: string; label: string }[];
        retired?: string[];
      };
      if (!res.ok || !data.outline) {
        setError(data.error ?? 'Could not plan the document.');
        return;
      }
      setPlan({
        title: data.outline.title,
        sections: data.outline.sections.map((s) => s.title),
        // Kept, not discarded. "You ticked Hidden work and this estimate has
        // none" is the most useful thing a preview can say, and it is the
        // reason to look before generating.
        empty: data.empty ?? [],
        retired: data.retired ?? [],
      });
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
      setPending('none');
    }
  };

  const generate = async (): Promise<void> => {
    if (!choice) return;
    setBusy(true);
    setPending('generate');
    setError(null);
    setPlan(null);
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
      setPending('none');
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

        {types.length > 0 && (
          <button
            type="button"
            onClick={() => void preview()}
            disabled={busy}
            className="mt-1.5 text-[11.5px] text-ink-3 underline-offset-2 hover:text-green hover:underline disabled:opacity-50"
            data-testid="preview-artifact-plan"
          >
            {pending === 'preview' ? 'Planning…' : 'Preview the plan first'}
          </button>
        )}

        {error && (
          <p className="mt-2 text-[12px] text-brick" role="alert" data-testid="artifact-panel-error">
            {error}
          </p>
        )}

        {plan && (
          <div
            className="mt-2.5 rounded-md border border-line-soft bg-surface-2 p-2.5"
            data-testid="artifact-plan"
          >
            <p className="text-[12px] font-semibold text-ink">{plan.title}</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[11.5px] text-ink-3">
              {plan.sections.map((s, i) => (
                <li key={`${s}-${i}`}>{s}</li>
              ))}
            </ol>
            <p className="mt-1.5 text-[11px] text-ink-4">
              Nothing generated yet — {plan.sections.length}{' '}
              {plan.sections.length === 1 ? 'section' : 'sections'} would be written.
            </p>

            {/* The reason to look before generating. A section the brief asks
                about but this estimate has no data for produces a thin or
                hedged document, and it is far cheaper to learn that here than
                after paying for every section. */}
            {plan.empty.length > 0 && (
              <p className="mt-1.5 text-[11px] text-bronze-ink" data-testid="artifact-plan-empty">
                Nothing to read in: {plan.empty.map((e) => e.label).join(', ')}. This estimate has
                none yet, so the document will have to work without{' '}
                {plan.empty.length === 1 ? 'it' : 'them'}.
              </p>
            )}

            {plan.retired.length > 0 && (
              <p className="mt-1.5 text-[11px] text-bronze-ink" data-testid="artifact-plan-retired">
                This type asks for {plan.retired.join(', ')}, which no longer exists. Untick it on
                the artifact type and save.
              </p>
            )}
          </div>
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
