'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createSection,
  renameSection,
  deleteSection,
  createMenuItem,
  renameMenuItem,
  setItemEnabled,
  deleteMenuItem,
  moveMenuItem,
  createLineItem,
  updateLineItem,
  setLineItemSide,
  deleteLineItem,
  setEstimateTaxPct,
} from './actions';
import {
  HOUSE_FIELD,
  isTaxableRole,
  OVERRIDE_FIELD,
  snapToQuarterHour,
  taxedHoursFor,
  type HouseRates,
  type RateOverrides,
  type TaxableRole,
  type TaxPercents,
} from '@repo/shared';
import type { TaxChangeNote } from '@/lib/estimate-tax';
import { retaxRole } from './dto';
import type { ItemDTO, SectionDTO, LineItemDTO } from './dto';
import { lockRegion, unlockRegion } from './lock-actions';
import { EMPTY_LOCK_STATE, type LockStateDTO } from './lock-dto';
import type { LockTarget } from '@repo/db';

export const ROLES = ['DEV', 'QA', 'PM', 'BA'] as const;
export type Role = (typeof ROLES)[number];
export const UNGROUPED = '__ungrouped__';
export type { TaxPercents };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

export const round = (n: number): number => Math.round(n * 100) / 100;
export const itemTaxed = (it: ItemDTO) => it.lineItems.reduce((s, li) => s + li.taxedHours, 0);

/** Hours per role for one item — what fills the role columns. */
export function byRole(it: ItemDTO): Record<Role, number> {
  const out: Record<Role, number> = { DEV: 0, QA: 0, PM: 0, BA: 0 };
  for (const li of it.lineItems) {
    if ((ROLES as readonly string[]).includes(li.role)) out[li.role as Role] += li.taxedHours;
  }
  return out;
}

type Ledger = {
  sections: SectionDTO[];
  items: ItemDTO[];
  /** Buffers in force: this estimate's override where set, house default otherwise. */
  taxPercents: TaxPercents;
  /** The house defaults, so "reset" can name the figure it reverts to. */
  houseRates: HouseRates | null;
  /** Which roles this estimate sets for itself. Null means inherit. */
  overrides: RateOverrides;
  /**
   * True once a buffer moved after the delivery-overhead cards were generated,
   * so those cards hold hours computed at superseded rates. They are badged
   * rather than regenerated — see setEstimateTaxPct for why.
   */
  overheadStale: boolean;
  /** The last change to each role's buffer, for the "why is this 35%" question. */
  taxChanges: Partial<Record<TaxableRole, TaxChangeNote>>;
  /** Set a role's buffer, or pass null to go back to inheriting the house rate. */
  onEditTaxPct: (role: TaxableRole, pct: number | null) => void;
  isFinalised: boolean;
  error: string | null;
  /** Enabled-only roll-up, recomputed live as items are edited or toggled. */
  rollup: {
    totals: Record<Role, number>;
    grand: number;
    /** Hours priced but switched off — excluded from every total above. */
    excluded: number;
    itemsOn: number;
    itemsOff: number;
    lineItemCount: number;
    /**
     * Hours inside `grand` that came from work the source material implied but
     * never stated. Counted, taxed and charged like anything else — kept
     * separate only so the total can say how much of itself was inferred.
     */
    inferred: number;
    inferredOn: number;
  };
  sectionsSorted: SectionDTO[];
  itemsIn: (sectionId: string | null) => ItemDTO[];
  containerOf: (id: string) => string | null;
  setSections: (s: SectionDTO[]) => void;
  setItems: (i: ItemDTO[]) => void;
  flashError: (e: unknown) => void;
  onAddSection: () => Promise<void>;
  onRenameSection: (id: string, title: string) => void;
  onDeleteSection: (id: string) => void;
  onAddItem: (sectionId: string | null) => Promise<void>;
  onRenameItem: (id: string, title: string) => void;
  onToggleItem: (id: string, enabled: boolean) => void;
  onDeleteItem: (id: string) => void;
  onAddLineItem: (menuItemId: string, role: Role) => Promise<void>;
  onEditLineTitle: (menuItemId: string, li: LineItemDTO, title: string) => void;
  onSetLineSide: (
    menuItemId: string,
    li: LineItemDTO,
    side: { touchesFrontend: boolean; touchesBackend: boolean },
  ) => void;
  onEditLineHours: (menuItemId: string, li: LineItemDTO, raw: number) => void;
  onDeleteLineItem: (menuItemId: string, id: string) => void;
  onMoveItem: (id: string, toSectionId: string | null, orderedIds: string[]) => void;

  // ── Locks (AEH-238) ────────────────────────────────────────────────────────
  /**
   * Which rows are frozen, and the two card-level facts derived from that.
   *
   * Not optimistic, unlike everything above it. A lock is a deliberate act
   * taken a few times per review rather than a keystroke, and one card-scoped
   * lock changes the rendering of every row on that card plus the card's own
   * controls — so the server returns the resolved truth and this is replaced
   * wholesale. Predicting it locally would be more code and less correct.
   */
  locks: LockStateDTO;
  /** True while a lock call is in flight, so the controls can stop double-firing. */
  lockBusy: boolean;
  /** Freeze one declaration of scope by role. */
  onLock: (target: LockTarget, roles: Role[]) => void;
  /**
   * Release one declaration. `override` is the confirmation for removing
   * somebody else's lock; without it their rows are reported and left standing.
   */
  onUnlock: (target: LockTarget, roles: Role[], override?: boolean) => void;
  /** Is this row frozen? The one question the editor asks per row. */
  isLineLocked: (lineItemId: string) => boolean;
  /**
   * Who is looking. Needed because a lock is a permission, and the controls
   * have to distinguish releasing your own from overriding a colleague's —
   * which is the difference between one click and a confirmed one.
   */
  viewerId: string;
  /** The estimate these rows belong to, for the actions that need naming it. */
  estimateId: string;
};

const LedgerContext = createContext<Ledger | null>(null);

export function useLedger(): Ledger {
  const ctx = useContext(LedgerContext);
  if (!ctx) throw new Error('useLedger must be used inside <LedgerProvider>');
  return ctx;
}

/**
 * Owns the menu card's client state so that the ledger and the sticky rail
 * roll-up read from the same source. The roll-up has to react the instant an
 * item is toggled, and the rail is rendered by a server component — a context
 * is what lets both live in one tree without lifting the whole page to a client
 * component.
 *
 * Every mutation is optimistic and reverts on a failed server action.
 */
export function LedgerProvider({
  initialSections,
  initialItems,
  taxPercents: initialTaxPercents,
  houseRates,
  initialOverrides,
  initialOverheadStale,
  taxChanges: initialTaxChanges,
  isFinalised,
  estimateId,
  initialLocks,
  viewerId,
  children,
}: {
  initialSections: SectionDTO[];
  initialItems: ItemDTO[];
  taxPercents: TaxPercents;
  houseRates: HouseRates | null;
  initialOverrides: RateOverrides;
  initialOverheadStale: boolean;
  taxChanges: Partial<Record<TaxableRole, TaxChangeNote>>;
  isFinalised: boolean;
  estimateId: string;
  initialLocks?: LockStateDTO;
  viewerId: string;
  children: ReactNode;
}) {
  const [sections, setSections] = useState<SectionDTO[]>(initialSections);
  const [items, setItems] = useState<ItemDTO[]>(initialItems);
  const [error, setError] = useState<string | null>(null);
  // The buffers are state, not a prop read straight through, because editing
  // one has to move the roll-up in the same paint as the input. The server
  // returns the authoritative figures and they are reconciled on arrival.
  const [taxPercents, setTaxPercents] = useState<TaxPercents>(initialTaxPercents);
  const [overrides, setOverrides] = useState<RateOverrides>(initialOverrides);
  const [overheadStale, setOverheadStale] = useState<boolean>(initialOverheadStale);
  const [taxChanges, setTaxChanges] =
    useState<Partial<Record<TaxableRole, TaxChangeNote>>>(initialTaxChanges);
  const [locks, setLocks] = useState<LockStateDTO>(initialLocks ?? EMPTY_LOCK_STATE);
  const [lockBusy, setLockBusy] = useState(false);

  const errTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashError = useCallback((e: unknown) => {
    setError(errMsg(e));
    if (errTimer.current) clearTimeout(errTimer.current);
    errTimer.current = setTimeout(() => setError(null), 4500);
  }, []);

  const sectionsSorted = useMemo(() => [...sections].sort((a, b) => a.order - b.order), [sections]);

  const itemsIn = useCallback(
    (sectionId: string | null) =>
      items.filter((i) => i.sectionId === sectionId).sort((a, b) => a.order - b.order),
    [items],
  );

  const containerOf = useCallback(
    (id: string): string | null => {
      if (id === UNGROUPED) return UNGROUPED;
      if (sections.some((s) => s.id === id)) return id; // a section container
      const it = items.find((i) => i.id === id);
      if (!it) return null;
      return it.sectionId ?? UNGROUPED;
    },
    [items, sections],
  );

  // Mirrors the server-side rollup: disabled items are priced but never counted.
  const rollup = useMemo(() => {
    const totals: Record<Role, number> = { DEV: 0, QA: 0, PM: 0, BA: 0 };
    let grand = 0;
    let excluded = 0;
    let itemsOn = 0;
    let lineItemCount = 0;
    // Work the SOW never asked for, counted separately. Same hours, same
    // taxation, same total — but a client reading "412h" deserves to know how
    // much of it they did not write down, and an estimator deciding whether to
    // argue for it needs the figure by itself.
    let inferred = 0;
    let inferredOn = 0;

    for (const it of items) {
      lineItemCount += it.lineItems.length;
      if (!it.enabled) {
        excluded += itemTaxed(it);
        continue;
      }
      itemsOn += 1;
      if (it.injected) inferredOn += 1;
      for (const li of it.lineItems) {
        if ((ROLES as readonly string[]).includes(li.role)) {
          totals[li.role as Role] += li.taxedHours;
          grand += li.taxedHours;
          if (it.injected) inferred += li.taxedHours;
        }
      }
    }
    return {
      totals,
      grand,
      excluded,
      itemsOn,
      itemsOff: items.length - itemsOn,
      lineItemCount,
      inferred,
      inferredOn,
    };
  }, [items]);

  const optimistic = useCallback(
    async (
      apply: () => void,
      revertTo: { s: SectionDTO[]; i: ItemDTO[] },
      server: () => Promise<void>,
    ) => {
      apply();
      try {
        await server();
      } catch (e) {
        setSections(revertTo.s);
        setItems(revertTo.i);
        flashError(e);
      }
    },
    [flashError],
  );
  const snapshot = () => ({ s: sections, i: items });

  // ── Sections ──
  const onAddSection = async () => {
    try {
      const created = await createSection(estimateId, 'New section');
      setSections((prev) => [...prev, created]);
    } catch (e) {
      flashError(e);
    }
  };
  const onRenameSection = (id: string, title: string) => {
    const snap0 = snapshot();
    void optimistic(
      () => setSections((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s))),
      snap0,
      () => renameSection(id, title),
    );
  };
  const onDeleteSection = (id: string) => {
    const snap0 = snapshot();
    void optimistic(
      () => {
        setSections((prev) => prev.filter((s) => s.id !== id));
        // Detach its items to Ungrouped (mirrors the server SetNull).
        setItems((prev) => prev.map((it) => (it.sectionId === id ? { ...it, sectionId: null } : it)));
      },
      snap0,
      () => deleteSection(id),
    );
  };

  // ── Items ──
  const onAddItem = async (sectionId: string | null) => {
    try {
      const created = await createMenuItem(estimateId, sectionId);
      setItems((prev) => [...prev, created]);
    } catch (e) {
      flashError(e);
    }
  };
  const onRenameItem = (id: string, title: string) => {
    const snap0 = snapshot();
    void optimistic(
      () => setItems((prev) => prev.map((it) => (it.id === id ? { ...it, title } : it))),
      snap0,
      () => renameMenuItem(id, title),
    );
  };
  const onToggleItem = (id: string, enabled: boolean) => {
    const snap0 = snapshot();
    void optimistic(
      () => setItems((prev) => prev.map((it) => (it.id === id ? { ...it, enabled } : it))),
      snap0,
      () => setItemEnabled(id, enabled),
    );
  };
  const onDeleteItem = (id: string) => {
    const snap0 = snapshot();
    void optimistic(
      () => setItems((prev) => prev.filter((it) => it.id !== id)),
      snap0,
      () => deleteMenuItem(id),
    );
  };

  // ── Line items ──
  const onAddLineItem = async (menuItemId: string, role: Role) => {
    try {
      const created = await createLineItem(menuItemId, role);
      setItems((prev) =>
        prev.map((it) =>
          it.id === menuItemId ? { ...it, lineItems: [...it.lineItems, created] } : it,
        ),
      );
    } catch (e) {
      flashError(e);
    }
  };
  const patchLineItem = (menuItemId: string, li: LineItemDTO) =>
    setItems((prev) =>
      prev.map((it) =>
        it.id === menuItemId
          ? { ...it, lineItems: it.lineItems.map((x) => (x.id === li.id ? li : x)) }
          : it,
      ),
    );
  const onEditLineTitle = (menuItemId: string, li: LineItemDTO, title: string) => {
    if (title === (li.title ?? '')) return;
    const snap0 = snapshot();
    void optimistic(
      () => patchLineItem(menuItemId, { ...li, title }),
      snap0,
      async () => {
        const updated = await updateLineItem(li.id, { title });
        patchLineItem(menuItemId, updated);
      },
    );
  };
  /**
   * Toggling a side never recomputes hours — that's the whole point of the
   * flags, so the optimistic patch deliberately carries baseHours/taxedHours
   * through untouched.
   */
  const onSetLineSide = (
    menuItemId: string,
    li: LineItemDTO,
    side: { touchesFrontend: boolean; touchesBackend: boolean },
  ) => {
    const snap0 = snapshot();
    void optimistic(
      () => patchLineItem(menuItemId, { ...li, ...side, edited: true }),
      snap0,
      async () => {
        const updated = await setLineItemSide(li.id, side);
        patchLineItem(menuItemId, updated);
      },
    );
  };
  const onEditLineHours = (menuItemId: string, li: LineItemDTO, raw: number) => {
    const base = snapToQuarterHour(Number.isFinite(raw) ? raw : 0);
    if (base === li.baseHours) return;
    const taxed = taxedHoursFor(base, taxPercents[li.role as Role] ?? 0);
    const snap0 = snapshot();
    void optimistic(
      () => patchLineItem(menuItemId, { ...li, baseHours: base, taxedHours: taxed, edited: true }),
      snap0,
      async () => {
        const updated = await updateLineItem(li.id, { baseHours: base });
        patchLineItem(menuItemId, updated);
      },
    );
  };
  const onDeleteLineItem = (menuItemId: string, id: string) => {
    const snap0 = snapshot();
    void optimistic(
      () =>
        setItems((prev) =>
          prev.map((it) =>
            it.id === menuItemId
              ? { ...it, lineItems: it.lineItems.filter((x) => x.id !== id) }
              : it,
          ),
        ),
      snap0,
      () => deleteLineItem(id),
    );
  };

  const onMoveItem = (id: string, toSectionId: string | null, orderedIds: string[]) => {
    const snap0 = snapshot();
    setItems((prev) =>
      prev.map((it) => {
        const idx = orderedIds.indexOf(it.id);
        if (idx === -1) return it;
        return { ...it, sectionId: toSectionId, order: idx };
      }),
    );
    moveMenuItem(id, toSectionId, orderedIds).catch((err) => {
      setSections(snap0.s);
      setItems(snap0.i);
      flashError(err);
    });
  };

  // ── Buffers ──
  /**
   * Move one role's buffer and re-tax that role's work in the same paint.
   *
   * The optimistic pass mirrors the server exactly: same `taxedHoursFor`, same
   * role-only scope, same exclusion of overhead cards — whose hours are already
   * a percentage OF taxed hours, so re-taxing one would compound. The server
   * then returns the figures it actually stored and those are applied over the
   * top, so a disagreement corrects itself instead of persisting as a total
   * that does not match the database.
   */
  const onEditTaxPct = (role: TaxableRole, pct: number | null) => {
    if (isFinalised) return;
    if (!isTaxableRole(role)) return;
    if ((overrides[OVERRIDE_FIELD[role]] ?? null) === pct) return;

    const before = {
      s: sections,
      i: items,
      pcts: taxPercents,
      ovr: overrides,
      stale: overheadStale,
      changes: taxChanges,
    };
    const nextPct = pct ?? (houseRates ? houseRates[HOUSE_FIELD[role]] : 0);

    setTaxPercents((prev) => ({ ...prev, [role]: nextPct }));
    setOverrides((prev) => ({ ...prev, [OVERRIDE_FIELD[role]]: pct }));
    setItems((prev) => retaxRole(prev, role, nextPct));

    void (async () => {
      try {
        const res = await setEstimateTaxPct(estimateId, role, pct);
        setTaxPercents(res.effective);
        setOverrides(res.overrides);
        setOverheadStale(res.overheadRatesStale);
        // Reconcile against what was actually stored.
        if (res.lineItems.length > 0) {
          const stored = new Map(res.lineItems.map((l) => [l.id, l.taxedHours]));
          setItems((prev) =>
            prev.map((it) => ({
              ...it,
              lineItems: it.lineItems.map((li) => {
                const taxed = stored.get(li.id);
                return taxed === undefined ? li : { ...li, taxedHours: taxed };
              }),
            })),
          );
        }
        // Optimistic provenance: the row is written, but the viewer's own email
        // is the server's to know. "just now" with no name is honest until the
        // next load fills both in.
        setTaxChanges((prev) => ({
          ...prev,
          [role]: {
            fromPct: before.ovr[OVERRIDE_FIELD[role]],
            toPct: pct,
            atLabel: 'just now',
            by: null,
          },
        }));
      } catch (e) {
        setSections(before.s);
        setItems(before.i);
        setTaxPercents(before.pcts);
        setOverrides(before.ovr);
        setOverheadStale(before.stale);
        setTaxChanges(before.changes);
        flashError(e);
      }
    })();
  };

  // ── Locks ──────────────────────────────────────────────────────────────────
  //
  // No optimistic prediction and no rollback, unlike every ledger mutation
  // above. Two reasons, and the second is the load-bearing one. A lock is a
  // considered act rather than a keystroke, so the round trip is not in
  // anybody's way. And the server may legitimately do LESS than was asked —
  // fourteen of sixteen rows, because a colleague holds the other two — which
  // a local prediction has no way to know and would render as a lie until the
  // next load.
  const applyLockResult = useCallback(
    (result: { state: LockStateDTO; notice: string | null }) => {
      setLocks(result.state);
      // A partial outcome is reported through the same channel as an error
      // because it is the same kind of news: something you asked for did not
      // happen. It is deliberately not thrown — locking most of a selection is
      // a success with a caveat, not a failure.
      if (result.notice) flashError(new Error(result.notice));
    },
    [flashError],
  );

  const onLock = useCallback(
    (target: LockTarget, roles: Role[]) => {
      setLockBusy(true);
      void (async () => {
        try {
          applyLockResult(await lockRegion(estimateId, target, [...roles]));
        } catch (e) {
          flashError(e);
        } finally {
          setLockBusy(false);
        }
      })();
    },
    [estimateId, applyLockResult, flashError],
  );

  const onUnlock = useCallback(
    (target: LockTarget, roles: Role[], override = false) => {
      setLockBusy(true);
      void (async () => {
        try {
          applyLockResult(await unlockRegion(estimateId, target, [...roles], override));
        } catch (e) {
          flashError(e);
        } finally {
          setLockBusy(false);
        }
      })();
    },
    [estimateId, applyLockResult, flashError],
  );

  const isLineLocked = useCallback(
    (lineItemId: string) => locks.lines[lineItemId] !== undefined,
    [locks],
  );

  const value: Ledger = {
    sections,
    items,
    taxPercents,
    houseRates,
    overrides,
    overheadStale,
    taxChanges,
    onEditTaxPct,
    isFinalised,
    error,
    rollup,
    sectionsSorted,
    itemsIn,
    containerOf,
    setSections,
    setItems,
    flashError,
    onAddSection,
    onRenameSection,
    onDeleteSection,
    onAddItem,
    onRenameItem,
    onToggleItem,
    onDeleteItem,
    onAddLineItem,
    onEditLineTitle,
    onSetLineSide,
    onEditLineHours,
    onDeleteLineItem,
    onMoveItem,
    locks,
    lockBusy,
    onLock,
    onUnlock,
    isLineLocked,
    viewerId,
    estimateId,
  };

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>;
}
