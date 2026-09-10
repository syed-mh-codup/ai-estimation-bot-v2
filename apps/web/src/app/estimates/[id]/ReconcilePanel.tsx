'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Minus, Plus, RefreshCw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Pill } from '@/components/ui/pill';
import {
  applyReconciliationAction,
  decideProposal,
  discardReconciliation,
  startReconciliation,
} from './reconcile-actions';
import { netHours, type ProposalDTO, type ReconciliationDTO } from './reconcile-dto';

const round = (n: number): string => (Math.round(n * 10) / 10).toLocaleString();
const signed = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${round(Math.abs(n))}`;

/** What each kind of proposal is, in one word, with the tone that fits it. */
const KIND_LABEL = { ADD: 'new', MODIFY: 'changed', REMOVE: 'dropped' } as const;

/**
 * Reconciling a fork against what changed. AEH-236.
 *
 * The decision is per CARD, never per line, and that is not a simplification.
 * A card is re-priced as a whole against its requirement, so taking half of one
 * produces work that contradicts itself — accept a DEV increase for a native
 * iOS sheet while rejecting the QA row that tests it, and the card claims work
 * nobody will check.
 *
 * Rejecting writes nothing and keeps the rationale, which is the half people
 * forget to build: "why is this still 18h when the brief changed" needs an
 * answer six weeks later, and the answer should be a sentence somebody can
 * disagree with rather than an absence.
 */
export function ReconcilePanel({
  estimateId,
  initial,
}: {
  estimateId: string;
  initial: ReconciliationDTO | null;
}) {
  const router = useRouter();
  const [rec, setRec] = useState<ReconciliationDTO | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pending, startTransition] = useTransition();

  const running = rec?.status === 'QUEUED' || rec?.status === 'RUNNING';

  // Polled only while a pass is in flight. A settled reconciliation is static,
  // and polling it would be a request every two seconds for the life of the tab.
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(async () => {
      try {
        const res = await fetch(`/api/estimates/${estimateId}/reconcile`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        setRec(data.reconciliation ?? null);
        // The ledger is untouched until an apply, so nothing needs refreshing
        // while it runs — only once proposals exist is there anything to read.
      } catch {
        /* transient — the next tick retries */
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [running, estimateId]);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/estimates/${estimateId}/reconcile`, { cache: 'no-store' });
    if (res.ok) setRec((await res.json()).reconciliation ?? null);
  }, [estimateId]);

  const start = (): void => {
    setError(null);
    startTransition(async () => {
      const out = await startReconciliation(estimateId);
      if (out.kind === 'refused') return setError(out.error);
      await refresh();
    });
  };

  const decide = (id: string, decision: 'ACCEPTED' | 'REJECTED' | 'PENDING'): void => {
    setError(null);
    // Optimistic: a review of forty cards should feel like ticking a list, not
    // like forty round trips. The server is authoritative and a refusal reverts.
    setRec((r) =>
      r ? { ...r, proposals: r.proposals.map((p) => (p.id === id ? { ...p, decision } : p)) } : r,
    );
    startTransition(async () => {
      const out = await decideProposal(id, decision);
      if (out.kind === 'refused') {
        setError(out.error);
        await refresh();
      }
    });
  };

  const apply = (overwrite = false): void => {
    setError(null);
    startTransition(async () => {
      const out = await applyReconciliationAction(rec!.id, overwrite);
      if (out.kind === 'refused') {
        setError(out.error);
        setConflict(out.error.includes('changed while'));
        return;
      }
      setConflict(false);
      await refresh();
      // The ledger really moved this time.
      router.refresh();
    });
  };

  const discard = (): void => {
    setError(null);
    startTransition(async () => {
      const out = await discardReconciliation(rec!.id);
      if (out.kind === 'refused') return setError(out.error);
      setRec(null);
    });
  };

  // ── Nothing has been run yet ───────────────────────────────────────────────
  if (!rec) {
    return (
      <div className="rounded-[10px] border border-line bg-surface px-4 py-3.5" data-testid="reconcile-panel">
        <div className="eyebrow font-bold text-ink-3">Reconcile</div>
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-4">
          Work out what this round has to change against the brief it was forked with. Nothing is
          written until you accept it.
        </p>
        <Button
          type="button"
          variant="outline"
          full
          className="mt-2.5"
          onClick={start}
          disabled={pending}
          data-testid="start-reconcile"
        >
          <RefreshCw className="h-4 w-4" />
          {pending ? 'Starting…' : 'Reconcile against the brief'}
        </Button>
        {error && (
          <p className="mt-1.5 text-[11.5px] text-brick" data-testid="reconcile-error">
            {error}
          </p>
        )}
      </div>
    );
  }

  // ── In flight ──────────────────────────────────────────────────────────────
  if (running) {
    return (
      <div className="rounded-[10px] border border-line bg-surface px-4 py-3.5" data-testid="reconcile-panel">
        <div className="eyebrow font-bold text-ink-3">Reconciling</div>
        <div className="mt-2 flex items-baseline justify-between text-[11.5px] text-ink-3">
          <span data-testid="reconcile-stage">{rec.stage ?? 'Starting…'}</span>
          <span className="num">{rec.pct}%</span>
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-line-soft">
          <div
            className="h-full bg-green transition-[width] duration-500"
            style={{ width: `${Math.max(2, rec.pct)}%` }}
          />
        </div>
      </div>
    );
  }

  if (rec.status === 'FAILED') {
    return (
      <div className="rounded-[10px] border border-brick-line bg-surface px-4 py-3.5" data-testid="reconcile-panel">
        <div className="eyebrow font-bold text-brick">Reconciliation failed</div>
        <p className="mt-1.5 text-[12px] leading-relaxed break-words text-ink-2">
          {rec.error ?? 'It stopped without saying why.'}
        </p>
        <Button type="button" variant="outline" full className="mt-2.5" onClick={discard} disabled={pending}>
          Clear
        </Button>
      </div>
    );
  }

  if (rec.status === 'APPLIED') {
    const accepted = rec.proposals.filter((p) => p.decision === 'ACCEPTED').length;
    const rejected = rec.proposals.filter((p) => p.decision === 'REJECTED').length;
    return (
      <div className="rounded-[10px] border border-line bg-surface px-4 py-3.5" data-testid="reconcile-panel">
        <div className="eyebrow font-bold text-ink-3">Reconciled</div>
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-3">
          <span className="num">{accepted}</span> change{accepted === 1 ? '' : 's'} applied
          {rejected > 0 && (
            <>
              , <span className="num">{rejected}</span> rejected
            </>
          )}
          . Every one of them is in the steered-edit history.
        </p>
        <Button
          type="button"
          variant="outline"
          full
          className="mt-2.5"
          onClick={start}
          disabled={pending}
          data-testid="start-reconcile"
        >
          <RefreshCw className="h-4 w-4" />
          Reconcile again
        </Button>
      </div>
    );
  }

  // ── PROPOSED: the review ───────────────────────────────────────────────────
  const undecided = rec.proposals.filter((p) => p.decision === 'PENDING').length;
  const accepted = rec.proposals.filter((p) => p.decision === 'ACCEPTED').length;
  const net = netHours(rec.proposals);

  return (
    <div className="rounded-[10px] border border-line bg-surface" data-testid="reconcile-panel">
      <div className="border-b border-line px-4 py-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="eyebrow font-bold text-ink-3">Proposed</span>
          <span className="num text-[12px] font-semibold text-green" data-testid="reconcile-net">
            {signed(net)}h
          </span>
        </div>
        <p className="mt-1 text-[11.5px] leading-snug text-ink-4">
          <span className="num">{rec.proposals.length}</span> change
          {rec.proposals.length === 1 ? '' : 's'} across{' '}
          <span className="num">{rec.triagedCount}</span> card
          {rec.triagedCount === 1 ? '' : 's'} it looked at. Nothing is written until you apply.
        </p>
        {rec.triageReasoning && (
          <p
            className="mt-1.5 border-l-2 border-line-soft pl-2 text-[11.5px] leading-snug text-ink-3"
            data-testid="reconcile-reasoning"
          >
            {rec.triageReasoning}
          </p>
        )}
      </div>

      {rec.proposals.length === 0 ? (
        <div className="px-4 py-4">
          {/* An empty proposal is a real answer, not a failure — but it is also
              what a broken triage looks like, so the count it examined is
              stated rather than left to be inferred from silence. */}
          <p className="text-[12px] leading-snug text-ink-3" data-testid="reconcile-empty">
            Nothing needs to change. It looked at{' '}
            <span className="num">{rec.triagedCount}</span> card
            {rec.triagedCount === 1 ? '' : 's'} and found no work the brief has moved.
          </p>
          <Button type="button" variant="outline" full className="mt-2.5" onClick={discard} disabled={pending}>
            Clear
          </Button>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-line-soft">
            {rec.proposals.map((p) => (
              <ProposalRow key={p.id} p={p} onDecide={decide} disabled={pending} />
            ))}
          </ul>

          <div className="border-t border-line px-4 py-3">
            {error && (
              <p className="mb-2 text-[11.5px] leading-snug text-brick" data-testid="reconcile-error">
                {error}
              </p>
            )}
            {undecided > 0 && (
              <p className="mb-2 text-[11.5px] text-ink-4" data-testid="reconcile-undecided">
                <span className="num">{undecided}</span> still undecided — they will be left alone.
              </p>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={discard}
                disabled={pending}
                data-testid="discard-reconcile"
              >
                Discard
              </Button>
              <Button
                type="button"
                className="flex-1"
                onClick={() => apply(conflict)}
                disabled={pending || accepted === 0}
                data-testid="apply-reconcile"
              >
                {conflict ? 'Apply anyway' : `Apply ${accepted}`}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ProposalRow({
  p,
  onDecide,
  disabled,
}: {
  p: ProposalDTO;
  onDecide: (id: string, d: 'ACCEPTED' | 'REJECTED' | 'PENDING') => void;
  disabled: boolean;
}) {
  const delta = p.delta;
  const tone =
    p.kind === 'ADD' ? 'green' : p.kind === 'REMOVE' ? 'brick' : ('bronze' as const);

  return (
    <li
      className={`px-4 py-3 ${p.decision === 'REJECTED' ? 'opacity-55' : ''}`}
      data-testid={`proposal-${p.id}`}
      data-decision={p.decision}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">{p.title}</span>
            <Pill tone={tone} className="px-1.5 py-0.5 text-[10px]">
              {KIND_LABEL[p.kind]}
            </Pill>
          </div>
          <p className="mt-1 text-[11.5px] leading-snug text-ink-3">{p.rationale}</p>
        </div>
        <span
          className={`num shrink-0 text-[12px] font-semibold ${
            delta > 0 ? 'text-green' : delta < 0 ? 'text-brick' : 'text-ink-4'
          }`}
        >
          {signed(delta)}h
        </span>
      </div>

      {/* The lines, always shown rather than behind a disclosure. A proposal
          whose detail arrives after a click is one people accept without
          reading — and this is the screen where a number a client sees moves. */}
      {p.rows.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {p.rows.map((r, i) => (
            <li key={`${p.id}-${i}`} className="flex items-baseline gap-2 text-[11px] text-ink-4">
              <span className="num w-7 shrink-0 font-semibold">{r.role}</span>
              <span className="min-w-0 flex-1 truncate">{r.title || '—'}</span>
              <span className="num shrink-0">{round(r.baseHours)}h</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex gap-1.5">
        <Button
          type="button"
          size="xs"
          variant={p.decision === 'ACCEPTED' ? 'default' : 'outline'}
          disabled={disabled}
          onClick={() => onDecide(p.id, p.decision === 'ACCEPTED' ? 'PENDING' : 'ACCEPTED')}
          data-testid={`accept-${p.id}`}
        >
          <Check className="h-3 w-3" />
          Accept
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className={p.decision === 'REJECTED' ? 'border-brick-line text-brick' : ''}
          disabled={disabled}
          onClick={() => onDecide(p.id, p.decision === 'REJECTED' ? 'PENDING' : 'REJECTED')}
          data-testid={`reject-${p.id}`}
        >
          <X className="h-3 w-3" />
          Reject
        </Button>
        {p.kind === 'ADD' && <Plus className="ml-auto h-3 w-3 self-center text-ink-4" />}
        {p.kind === 'REMOVE' && <Minus className="ml-auto h-3 w-3 self-center text-ink-4" />}
      </div>
    </li>
  );
}
