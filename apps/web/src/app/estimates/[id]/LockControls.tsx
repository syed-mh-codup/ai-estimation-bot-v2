'use client';

import { useState } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLedger, type Role } from './ledger-context';
import { lineLockHistory } from './lock-actions';
import type { LockEventDTO } from './lock-dto';
import type { ItemDTO } from './dto';

/**
 * The lock affordances on the ledger — AEH-238.
 *
 * Two controls and one story. A row can be frozen on its own; a card can be
 * frozen whole. Role-scoped freezing is deliberately absent here: picking roles
 * is already the interaction the edit envelope's selection bar provides, so a
 * second role picker on every card header would offer the same choice twice.
 * The data model addresses roles regardless — see `LockScope`.
 *
 * Releasing your own lock takes one click. Releasing a colleague's takes two,
 * and the second click IS the override confirmation. That is the only ceremony
 * there is, deliberately: no reason is collected, because what stops an override
 * being the same as the lock never having been set is the audited record, not a
 * justification nobody reads. An armed control also re-renders as `Override?`,
 * so the second click is a different act rather than the same one repeated.
 *
 * The history is fetched on hover rather than shipped with the page. A reviewer
 * opens one row's story when they want to know why they cannot edit it; an
 * estimate with two hundred locks would otherwise preload two hundred event
 * lists nobody reads.
 */

function scopeWords(scope: LockEventDTO['declaredScope']): string {
  switch (scope) {
    case 'ESTIMATE':
      return 'with the whole estimate';
    case 'SECTION':
      return 'with its section';
    case 'CARD':
      return 'with its card';
    case 'LINE':
      return 'on its own';
    // The statement axis, which this component also serves — the padlock and
    // the hover story are the same affordance wherever a lock appears.
    case 'STATEMENT':
      return 'on its own';
    case 'STATEMENT_LIST':
      return 'with the whole list';
  }
}

function eventWords(e: LockEventDTO): string {
  const when = new Date(e.at).toLocaleString();
  switch (e.kind) {
    case 'LOCKED':
      return `${e.actorName} locked it ${scopeWords(e.declaredScope)} — ${when}`;
    case 'UNLOCKED':
      return `${e.actorName} unlocked it — ${when}`;
    case 'OVERRIDDEN':
      return `${e.actorName} overrode ${e.priorHolderName ?? 'a colleague'}'s lock — ${when}`;
  }
}

/** The badge on a frozen row: who holds it, its story on hover, click to release. */
export function LineLockBadge({
  lineItemId,
  estimateId,
}: {
  lineItemId: string;
  estimateId: string;
}) {
  const { locks, lockBusy, onUnlock, isFinalised, viewerId } = useLedger();
  const [history, setHistory] = useState<LockEventDTO[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [armed, setArmed] = useState(false);

  const lock = locks.lines[lineItemId];
  if (!lock) return null;
  const mine = lock.lockedById === viewerId;

  const loadHistory = (): void => {
    if (history !== null || loading) return;
    setLoading(true);
    void (async () => {
      try {
        setHistory(await lineLockHistory(estimateId, lineItemId));
      } catch {
        // A history that will not load must not break the badge: the lock is
        // still true and still worth showing.
        setHistory([]);
      } finally {
        setLoading(false);
      }
    })();
  };

  return (
    <span className="group/lock relative shrink-0">
      <button
        type="button"
        disabled={isFinalised || lockBusy}
        onMouseEnter={loadHistory}
        onFocus={loadHistory}
        onBlur={() => setArmed(false)}
        onClick={() => {
          if (mine) {
            onUnlock({ scope: 'LINE', id: lineItemId }, [], false);
            return;
          }
          if (!armed) {
            setArmed(true);
            return;
          }
          onUnlock({ scope: 'LINE', id: lineItemId }, [], true);
          setArmed(false);
        }}
        aria-label={
          mine
            ? 'You locked this line. Unlock it.'
            : armed
              ? `Confirm overriding ${lock.lockedByName}'s lock`
              : `Locked by ${lock.lockedByName}. Unlock this line.`
        }
        className={cn(
          'num flex items-center gap-0.5 rounded border px-1 text-[9.5px] font-bold tracking-[0.06em] uppercase disabled:opacity-60',
          armed
            ? 'border-brick bg-brick/10 text-brick'
            : 'border-bronze-line bg-surface text-bronze-ink',
        )}
        data-testid={`line-lock-${lineItemId}`}
      >
        <Lock className="h-2.5 w-2.5" aria-hidden />
        {armed ? 'override?' : 'locked'}
      </button>

      {/* Positioned rather than a `title` attribute: it is several lines, and a
          native tooltip would collapse them onto one. */}
      <span
        role="tooltip"
        className="pointer-events-none absolute top-full left-0 z-20 mt-1 hidden w-[280px] flex-col gap-0.5 rounded-[6px] border border-line bg-surface px-2 py-1.5 text-[11px] leading-snug text-ink-2 shadow-sm group-focus-within/lock:flex group-hover/lock:flex"
        data-testid={`line-lock-history-${lineItemId}`}
      >
        {/* Reads `lockedAt` and `declaredScope` rather than merely carrying
            them: when it was frozen, and whether it was frozen on its own or
            swept up in a coarser selection, are the two things a reviewer who
            cannot edit a row actually wants to know. */}
        <span className="font-semibold text-ink">
          Locked by {mine ? 'you' : lock.lockedByName} {scopeWords(lock.declaredScope)}
        </span>
        <span className="text-ink-4">
          since{' '}
          {new Date(lock.lockedAt).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
          })}
        </span>
        {loading && <span className="text-ink-4">Loading history…</span>}
        {history?.map((e, i) => (
          <span key={i} className="text-ink-3">
            {eventWords(e)}
          </span>
        ))}
        {history?.length === 0 && !loading && (
          <span className="text-ink-4">No history recorded.</span>
        )}
      </span>
    </span>
  );
}

/**
 * The badge on a frozen statement: who holds it, its story on hover, click to
 * release.
 *
 * A sibling of `LineLockBadge` rather than a generic over both, and the reason
 * is the shape of what it reads. A row lock is keyed by `lineItemId` and
 * released with a `scope x role` declaration; a statement lock is keyed by
 * `statementId` and released with a declaration that has no role axis at all.
 * A version parameterised over both would spend most of itself deciding which
 * of two vocabularies it was in.
 *
 * What IS shared is everything a person sees: the same words for the same
 * events, the same one-click-yours / two-clicks-theirs rule, and the same
 * history read out of the same `LockEvent` table.
 */
export function StatementLockBadge({
  statementId,
  estimateId,
}: {
  statementId: string;
  estimateId: string;
}) {
  const { locks, lockBusy, onUnlockStatement, isFinalised, viewerId } = useLedger();
  const [history, setHistory] = useState<LockEventDTO[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [armed, setArmed] = useState(false);

  const lock = locks.statements[statementId];
  if (!lock) return null;
  const mine = lock.lockedById === viewerId;

  const loadHistory = (): void => {
    if (history !== null || loading) return;
    setLoading(true);
    void (async () => {
      try {
        setHistory(await lineLockHistory(estimateId, { statementId }));
      } catch {
        setHistory([]);
      } finally {
        setLoading(false);
      }
    })();
  };

  return (
    <span className="group/lock relative mt-0.5 shrink-0">
      <button
        type="button"
        disabled={isFinalised || lockBusy}
        onMouseEnter={loadHistory}
        onFocus={loadHistory}
        onBlur={() => setArmed(false)}
        onClick={() => {
          if (mine) {
            onUnlockStatement({ scope: 'STATEMENT', id: statementId }, false);
            return;
          }
          if (!armed) {
            setArmed(true);
            return;
          }
          onUnlockStatement({ scope: 'STATEMENT', id: statementId }, true);
          setArmed(false);
        }}
        aria-label={
          mine
            ? 'You locked this line. Unlock it.'
            : armed
              ? `Confirm overriding ${lock.lockedByName}'s lock`
              : `Locked by ${lock.lockedByName}. Unlock this line.`
        }
        className={cn(
          'num flex items-center gap-0.5 rounded border px-1 text-[9.5px] font-bold tracking-[0.06em] uppercase disabled:opacity-60',
          armed
            ? 'border-brick bg-brick/10 text-brick'
            : 'border-bronze-line bg-surface text-bronze-ink',
        )}
        data-testid={`statement-lock-${statementId}`}
      >
        <Lock className="h-2.5 w-2.5" aria-hidden />
        {armed ? 'override?' : 'locked'}
      </button>

      <span
        role="tooltip"
        className="pointer-events-none absolute top-full right-0 z-20 mt-1 hidden w-[280px] flex-col gap-0.5 rounded-[6px] border border-line bg-surface px-2 py-1.5 text-[11px] leading-snug text-ink-2 shadow-sm group-focus-within/lock:flex group-hover/lock:flex"
        data-testid={`statement-lock-history-${statementId}`}
      >
        <span className="font-semibold text-ink">
          Locked by {mine ? 'you' : lock.lockedByName} {scopeWords(lock.declaredScope)}
        </span>
        <span className="text-ink-4">
          since{' '}
          {new Date(lock.lockedAt).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
          })}
        </span>
        {loading && <span className="text-ink-4">Loading history…</span>}
        {history?.map((e, i) => (
          <span key={i} className="text-ink-3">
            {eventWords(e)}
          </span>
        ))}
        {history?.length === 0 && !loading && (
          <span className="text-ink-4">No history recorded.</span>
        )}
      </span>
    </span>
  );
}

/**
 * The open padlock on an unlocked row. AEH-238.
 *
 * The `LINE` scope, which `resolveTarget` has always supported and the UI could
 * not reach: `LineLockBadge` only renders once a row is ALREADY locked, so
 * there was no way to lock one. The reporter found this from the other end — a
 * dev who locks their finished work wants to freeze THEIR rows, and the only
 * control available froze all four roles and blocked their colleagues.
 */
export function LineLockButton({ lineItemId }: { lineItemId: string }) {
  const { locks, lockBusy, onLock, isFinalised } = useLedger();
  if (isFinalised || locks.lines[lineItemId]) return null;

  return (
    <button
      type="button"
      disabled={lockBusy}
      onClick={() => onLock({ scope: 'LINE', id: lineItemId }, [])}
      title="Lock this line — freezes its hours, its description and its existence, for people and for the AI."
      aria-label="Lock this line"
      // `group/line` is the NAME the line row uses, and an unnamed
      // `group-hover:` here would never fire — the padlock would be permanently
      // invisible and the LINE scope would stay unreachable, which is the bug
      // this component exists to fix.
      className="shrink-0 px-0.5 text-line opacity-0 group-hover/line:text-ink-4 group-hover/line:opacity-100 disabled:opacity-50"
      data-testid={`line-lock-set-${lineItemId}`}
    >
      <LockOpen className="h-3 w-3" aria-hidden />
    </button>
  );
}

/**
 * Freeze or release ONE ROLE of a card, or of the whole estimate. AEH-238.
 *
 * The affordance the feature was missing. The storage was always per row and
 * `resolveTarget` always understood `scope x role`, but the only control that
 * created a lock was the card padlock, which hard-coded all four roles — so a
 * dev locking their finished work froze QA, PM and BA too and forced each
 * colleague through the override ceremony to edit their own lines.
 *
 * One component for both scopes because the act is identical and only the
 * target differs, and it is placed WHERE THAT SCOPE'S NUMBER IS: in the card's
 * role cell for a card, in the estimate's role column head for the estimate.
 * That is the same correspondence the envelope relies on — a lock and a
 * selection are one coordinate system read in two directions — made visible.
 *
 * Three states, like `CardLockButton`, and for the same reason: a role slice
 * can be partly frozen, and a plain open padlock over four locked DEV rows
 * would surprise whoever's edit is then refused.
 */
export function RoleLockButton({
  target,
  role,
  label,
}: {
  /** A card, or the whole estimate. */
  target: { scope: 'CARD'; id: string } | { scope: 'ESTIMATE' };
  role: Role;
  /** What this covers, for the title text — "this card" / "every card". */
  label: string;
}) {
  const { items, locks, lockBusy, onLock, onUnlock, isFinalised, viewerId } = useLedger();
  const [armed, setArmed] = useState(false);
  if (isFinalised) return null;

  // The rows this declaration covers, counted from what is on screen. The
  // server resolves it again through `resolveTarget`; this is what decides how
  // the control renders.
  const covered = (target.scope === 'CARD' ? items.filter((i) => i.id === target.id) : items)
    .flatMap((i) => i.lineItems)
    .filter((li) => li.role === role);
  // An empty slice is not a locked slice, and it has nothing to lock either.
  if (covered.length === 0) return null;

  const frozen = covered.filter((li) => locks.lines[li.id] !== undefined);
  const full = frozen.length === covered.length;
  const partial = frozen.length > 0 && !full;
  const anyLocked = frozen.length > 0;
  const holdsOthers = frozen.some((li) => locks.lines[li.id]?.lockedById !== viewerId);

  return (
    <button
      type="button"
      disabled={lockBusy}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!anyLocked) {
          onLock(target, [role]);
          return;
        }
        if (holdsOthers && !armed) {
          setArmed(true);
          return;
        }
        onUnlock(target, [role], armed);
        setArmed(false);
      }}
      title={
        armed
          ? `Click again to override a colleague’s lock on ${role} across ${label}.`
          : full
            ? `Every ${role} line on ${label} is locked. Click to unlock.`
            : partial
              ? `${frozen.length} of ${covered.length} ${role} lines on ${label} are locked. Click to unlock them.`
              : `Lock ${role} on ${label} — freezes ${covered.length} line${
                  covered.length === 1 ? '' : 's'
                }, and nothing of any other role.`
      }
      aria-label={
        anyLocked ? `Unlock ${role} on ${label}` : `Lock ${role} on ${label}`
      }
      className={cn(
        'shrink-0 align-middle disabled:opacity-50',
        armed
          ? 'text-brick'
          : full
            ? 'text-bronze-ink'
            : partial
              ? 'text-bronze-ink/60'
              : 'text-line opacity-0 group-hover:text-ink-4 group-hover:opacity-100',
      )}
      data-testid={`role-lock-${target.scope === 'CARD' ? target.id : 'estimate'}-${role}`}
    >
      {anyLocked ? (
        <Lock className="h-3 w-3" aria-hidden />
      ) : (
        <LockOpen className="h-3 w-3" aria-hidden />
      )}
    </button>
  );
}

/**
 * Freeze or release a whole card.
 *
 * Three states rather than two, because a card can be partly frozen — one
 * role's slice locked, the rest open. Saying so matters: a reviewer seeing a
 * plain open padlock on a card holding four frozen DEV rows will be surprised
 * when a delete is refused.
 */
export function CardLockButton({ item }: { item: ItemDTO }) {
  const { locks, lockBusy, onLock, onUnlock, isFinalised, viewerId } = useLedger();
  const [armed, setArmed] = useState(false);
  if (isFinalised) return null;

  const full = locks.cardsFullyLocked.includes(item.id);
  const partial = !full && locks.cardsWithAnyLock.includes(item.id);
  const anyLocked = full || partial;
  // Whether releasing this card would touch somebody else's lock, which is what
  // decides between one click and a confirmed one.
  const holdsOthers = item.lineItems.some((li) => {
    const l = locks.lines[li.id];
    return l !== undefined && l.lockedById !== viewerId;
  });
  const target = { scope: 'CARD' as const, id: item.id };
  const roles = ['DEV', 'QA', 'PM', 'BA'] as const;

  return (
    <button
      type="button"
      disabled={lockBusy}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!anyLocked) {
          onLock(target, [...roles]);
          return;
        }
        if (holdsOthers && !armed) {
          setArmed(true);
          return;
        }
        onUnlock(target, [...roles], armed);
        setArmed(false);
      }}
      title={
        armed
          ? 'Click again to override a colleague’s lock on this card.'
          : full
            ? 'Every line on this card is locked. Click to unlock.'
            : partial
              ? 'Some lines on this card are locked. Click to unlock them.'
              : 'Lock this card — freezes its hours, descriptions and existence.'
      }
      aria-label={anyLocked ? 'Unlock this card' : 'Lock this card'}
      className={cn(
        'shrink-0 px-1 disabled:opacity-50',
        armed
          ? 'text-brick'
          : full
            ? 'text-bronze-ink'
            : partial
              ? 'text-bronze-ink/60'
              : 'text-line opacity-0 group-hover:text-ink-4 group-hover:opacity-100',
      )}
      data-testid={`card-lock-${item.id}`}
    >
      {anyLocked ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <LockOpen className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}
