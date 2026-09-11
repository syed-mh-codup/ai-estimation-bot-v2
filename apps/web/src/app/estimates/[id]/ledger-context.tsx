'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
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
import type { ItemDTO, SectionDTO, LineItemDTO, MutationOutcome } from './dto';
import { isDimmed, markCounts, type MarkContext, type MarkKey } from './marks';
import {
  lockRegion,
  lockStatementRegion,
  unlockRegion,
  unlockStatementRegion,
} from './lock-actions';
import { listLedgerEdits, startLedgerEdit, startStatementEdit } from './edit-actions';
import {
  EMPTY_EDIT_COUNTS,
  isEditInFlight,
  type LedgerEditCounts,
  type LedgerEditDTO,
  type LedgerEditMode,
} from './edit-dto';
import { EMPTY_LOCK_STATE, type LockStateDTO } from './lock-dto';
import type { LockTarget } from '@repo/db';

export const ROLES = ['DEV', 'QA', 'PM', 'BA'] as const;
export type Role = (typeof ROLES)[number];
export const UNGROUPED = '__ungrouped__';
export type { TaxPercents };

/**
 * What a failed mutation says out loud.
 *
 * The guard clause is not defensive noise. A server action that THROWS does not
 * deliver its message in a production build: React's Flight client drops it and
 * substitutes "An error occurred in the Server Components render. The specific
 * message is omitted in production builds…", which this banner then showed to a
 * reviewer verbatim. Every carefully worded refusal in `lib/lock-guards.ts`
 * arrived as that paragraph once deployed — the message was only ever legible
 * in `next dev`, which is why it survived review.
 *
 * So a redacted error is recognised and replaced with something true. A refusal
 * a person is meant to ACT on travels as a return value instead of a throw —
 * see `setItemEnabled` — and never reaches this fallback.
 *
 * Matched on the message rather than on the `digest` property React also
 * attaches, deliberately. `next dev` forwards the real message AND a digest, so
 * keying on the digest would throw away the only useful text exactly where a
 * developer is reading it. Matching the boilerplate fails safe in the other
 * direction: if React ever rewords it we show its wording, which is today's
 * behaviour, not a wrong message.
 */
const errMsg = (e: unknown) => {
  if (!(e instanceof Error)) return 'Something went wrong';
  if (e.message.includes('An error occurred in the Server Components render')) {
    // Deliberately not "refused". Everything redacted arrives here looking the
    // same — a policy refusal, a dropped Neon connection, a row deleted in
    // another tab — and claiming the server said no would be a guess about
    // which. What is certainly true is that nothing was written.
    return "That change didn't go through. Reload to see where the ledger actually stands.";
  }
  return e.message;
};

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

  // ── Marks (AEH-377) ────────────────────────────────────────────────────────
  /**
   * How many cards carry each mark, for the chips above the ledger — and only
   * the marks something here actually carries.
   *
   * This is a summary before it is a filter: it answers "what is unusual about
   * this estimate" without anybody clicking, which is the thing a legend could
   * never do. It can also report an ABSENCE — "7 cards with no preset match" is
   * not a visual mark at all, and no key could have listed it.
   */
  markCounts: Partial<Record<MarkKey, number>>;
  /** The mark being looked at, if any. Everything without it dims. */
  activeMark: MarkKey | null;
  /** Pick a mark, or pass the one already active to go back to showing all. */
  setActiveMark: (mark: MarkKey | null) => void;
  /** Should this card recede while `activeMark` is being looked at? */
  isCardDimmed: (item: ItemDTO) => boolean;

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

  // ── The edit envelope (AEH-238) ─────────────────────────────────────────────
  /**
   * What the person has declared may change: cards, and which of their roles.
   *
   * Two independent axes rather than a list of rows, which is what makes this
   * two clicks instead of a multi-select over hundreds of lines. It is also the
   * same coordinate system a lock uses, read in the opposite direction.
   *
   * Arrays rather than Sets because this crosses into server actions, and a Set
   * does not survive that boundary.
   */
  selectedCardIds: string[];
  selectedRoles: Role[];
  toggleCardSelected: (cardId: string) => void;
  toggleRoleSelected: (role: Role) => void;
  clearSelection: () => void;
  /** Every steered edit the ledger still cares about, newest first. */
  edits: LedgerEditDTO[];
  /** True while a dispatch is in flight, so the button can stop double-firing. */
  editBusy: boolean;
  /** Declare the current selection and say what should happen to it. */
  onSteer: (prompt: string, mode: LedgerEditMode) => Promise<void>;
  /** Replace the edit list — used by the decision and revert controls. */
  setEdits: (next: LedgerEditDTO[]) => void;
  /** How many edits are in each state, over all of them rather than the page. */
  editCounts: LedgerEditCounts;

  // ── The statement axis (AEH-238) ────────────────────────────────────────────
  /**
   * Which narrative lines or assumptions are ticked, and which list they are in.
   *
   * ONE list at a time, and the constraint is deliberate rather than a
   * simplification: the narrative and the assumptions are two documents with
   * different jobs, and one instruction about both would be exactly the vague
   * boundary this feature exists to replace. Ticking a line in the other list
   * moves the selection rather than widening it.
   *
   * No role axis. A statement is one sentence — there is nothing to narrow it
   * by, and inventing a dimension for symmetry's sake would put a control on
   * screen that means nothing.
   */
  statementKind: 'NARRATIVE' | 'ASSUMPTION' | null;
  selectedStatementIds: string[];
  toggleStatementSelected: (statementId: string, kind: 'NARRATIVE' | 'ASSUMPTION') => void;
  clearStatementSelection: () => void;
  /** Freeze one statement, or a whole list. */
  onLockStatement: (target: StatementTargetDTO) => void;
  /** Release one. `override` confirms removing somebody else's. */
  onUnlockStatement: (target: StatementTargetDTO, override?: boolean) => void;
  /** Declare the ticked statements and say what is wrong with them. */
  onSteerStatements: (prompt: string) => Promise<void>;
};

/**
 * A statement declaration, as the client states it.
 *
 * Mirrors `StatementTarget` in `@repo/db` rather than importing it, for the
 * reason `lock-dto.ts` exists: this module is a client component, and the type
 * would arrive through a module that pulls Prisma into the bundle.
 */
export type StatementTargetDTO =
  | { scope: 'STATEMENT'; id: string }
  | { scope: 'STATEMENT_LIST'; kind: 'NARRATIVE' | 'ASSUMPTION' };

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
  renderedAt,
  initialEdits,
  initialEditCounts,
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
  /**
   * When the server produced this screen. The pre-flight staleness check
   * compares the region's last write against it, which is how "what you are
   * looking at may not be what gets re-priced" is answerable without shipping
   * an `updatedAt` for every one of hundreds of rows.
   */
  renderedAt: string;
  initialEdits?: LedgerEditDTO[];
  initialEditCounts?: LedgerEditCounts;
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
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [selectedRoles, setSelectedRoles] = useState<Role[]>([]);
  const [statementKind, setStatementKind] = useState<'NARRATIVE' | 'ASSUMPTION' | null>(null);
  const [selectedStatementIds, setSelectedStatementIds] = useState<string[]>([]);
  const [edits, setEdits] = useState<LedgerEditDTO[]>(initialEdits ?? []);
  /**
   * TRUE counts, over every edit rather than the page `edits` holds.
   *
   * The list is capped so a two-second poll stays cheap; the counts are not,
   * because "did my thirty-card re-price actually start" is exactly the
   * question a capped list cannot answer.
   */
  const [editCounts, setEditCounts] = useState<LedgerEditCounts>(
    initialEditCounts ?? EMPTY_EDIT_COUNTS,
  );
  const [editBusy, setEditBusy] = useState(false);
  const router = useRouter();
  /**
   * What was running as of the last poll.
   *
   * A ref rather than derived from `edits`, because the question is about the
   * TRANSITION — "did something that was running stop" — and comparing against
   * state inside the callback that sets it would compare a value against
   * itself.
   */
  const inFlightIds = useRef<Set<string>>(
    new Set((initialEdits ?? []).filter(isEditInFlight).map((e) => e.id)),
  );

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

  // ── Marks (AEH-377) ────────────────────────────────────────────────────────
  const [activeMark, setActiveMarkState] = useState<MarkKey | null>(null);

  /**
   * Locks arrive as a map keyed by line id; the mark functions want a Set they
   * can probe per row without rebuilding it for every card on the estimate.
   */
  const markContext = useMemo<MarkContext>(
    () => ({ overheadStale, lockedLineIds: new Set(Object.keys(locks.lines)) }),
    [overheadStale, locks],
  );

  const counts = useMemo(() => markCounts(items, markContext), [items, markContext]);

  /**
   * Clicking the mark you are already looking at goes back to showing
   * everything, so the chip is its own escape. Without this the only way out is
   * the "Show all" link beside the row, and a filter you can enter more easily
   * than you can leave is a trap.
   */
  const setActiveMark = useCallback((mark: MarkKey | null) => {
    setActiveMarkState((prev) => (mark !== null && prev === mark ? null : mark));
  }, []);

  /**
   * A mark that stops existing stops being looked at. Switching the last "off"
   * card back on while filtering by it would otherwise leave every row dimmed
   * and no chip lit to explain why — an empty ledger that looks broken.
   */
  useEffect(() => {
    if (activeMark !== null && counts[activeMark] === undefined) setActiveMarkState(null);
  }, [activeMark, counts]);

  const isCardDimmed = useCallback(
    (item: ItemDTO) => isDimmed(item, activeMark, markContext),
    [activeMark, markContext],
  );

  /**
   * Apply now, keep it if the server agrees, put it back if it does not.
   *
   * Two ways the server can disagree, and they are not the same thing. A THROW
   * is a fault — the row is gone, the session lapsed — and its message is
   * redacted in a production build, so `errMsg` substitutes something honest. A
   * returned `refused` is policy: the ledger asked, the rule said no, and the
   * sentence explaining which locks and whose survives the boundary intact.
   * Both revert; only one can tell the reader what to do about it.
   */
  const optimistic = useCallback(
    async (
      apply: () => void,
      revertTo: { s: SectionDTO[]; i: ItemDTO[] },
      server: () => Promise<void | MutationOutcome>,
    ) => {
      apply();
      const revert = () => {
        setSections(revertTo.s);
        setItems(revertTo.i);
      };
      try {
        const outcome = await server();
        if (outcome && outcome.kind === 'refused') {
          revert();
          flashError(new Error(outcome.error));
        }
      } catch (e) {
        revert();
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
      () => patchLineItem(menuItemId, { ...li, ...side, provenance: 'HUMAN' }),
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
      () =>
        patchLineItem(menuItemId, {
          ...li,
          baseHours: base,
          taxedHours: taxed,
          provenance: 'HUMAN',
        }),
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

  // ── The edit envelope ──────────────────────────────────────────────────────
  const toggleCardSelected = useCallback((cardId: string) => {
    setSelectedCardIds((prev) =>
      prev.includes(cardId) ? prev.filter((id) => id !== cardId) : [...prev, cardId],
    );
  }, []);

  const toggleRoleSelected = useCallback((role: Role) => {
    setSelectedRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedCardIds([]);
    setSelectedRoles([]);
  }, []);

  /**
   * Poll while anything is in flight, and stop as soon as nothing is.
   *
   * Recursive `setTimeout` rather than an interval, so a slow response cannot
   * stack requests behind itself — the next poll is scheduled only once the
   * previous one has answered.
   */
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const poll = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(() => {
      void (async () => {
        try {
          const next = await listLedgerEdits(estimateId);
          const wasInFlight = inFlightIds.current;
          setEdits(next.edits);
          setEditCounts(next.counts);
          const nowInFlight = new Set(next.edits.filter(isEditInFlight).map((e) => e.id));
          inFlightIds.current = nowInFlight;

          // Something that WAS running has stopped, so the ledger underneath
          // this panel has changed and the screen is now wrong. Every other
          // background job in this app refreshes when it lands (ScopeDerive,
          // ScopeScenarios, ScopeGraphEditor); this one did not, so a person
          // watched an edit reach "Applied" while the cards kept showing the
          // hours it had just replaced.
          //
          // The refresh re-runs the server component, which changes
          // `editorKey` — the pinned rows were deleted and replaced, so their
          // ids are new — and the provider remounts on the real numbers.
          const landed = [...wasInFlight].some((id) => !nowInFlight.has(id));
          if (landed) router.refresh();

          if (nowInFlight.size > 0) poll();
        } catch {
          // A dropped poll is not worth telling anybody about: the edit is
          // durable, and the next poll or a reload will show where it got to.
        }
      })();
    }, 2000);
  }, [estimateId, router]);

  /**
   * Adopt the server's rows whenever the server has drawn this screen again.
   *
   * `renderedAt` is stamped fresh on every server render and never changes on a
   * client one, which makes it exactly the signal for "the server is
   * authoritative again" — a reload, a navigation, or the `router.refresh()`
   * this file fires when a steered edit lands. A re-price replaces its rows
   * with new ids, so without this the ledger kept rendering the hours the edit
   * had just replaced.
   *
   * A key on the provider would do the same job by remounting, and that was the
   * first attempt. It is worse: remounting mid-edit closes the activity sheet
   * the person is watching the edit in, and throws away their selection. This
   * keeps both.
   */
  useEffect(() => {
    setSections(initialSections);
    setItems(initialItems);
    // Keyed on the server-render stamp ALONE, deliberately. `initialItems` is a
    // new array reference on every render, so depending on it would re-run this
    // effect on its own output.
    //
    // (No eslint-disable here: `react-hooks/exhaustive-deps` is not configured
    // in this repo, and disabling a rule that does not exist is itself an
    // error under `next build`'s stricter lint pass.)
  }, [renderedAt]);

  // Resume polling for work that was already running when this screen was
  // drawn. Without it, `poll` only ever starts from inside a steer, so an edit
  // survived a reload as a static row that never advanced.
  useEffect(() => {
    if ((initialEdits ?? []).some(isEditInFlight)) poll();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [initialEdits, poll]);

  const onSteer = useCallback(
    async (prompt: string, mode: LedgerEditMode) => {
      // One card and one role at the least. Resolved server-side too — this is
      // the courtesy, not the guarantee.
      if (selectedCardIds.length === 0 || selectedRoles.length === 0) {
        flashError(new Error('Pick at least one card and one role first.'));
        return;
      }
      setEditBusy(true);
      try {
        // A merge is ONE edit over all the selected cards, because the point is
        // that they become one thing; everything else is one edit per card, so
        // a failure on one does not take the others down with it. The envelope's
        // scope axis has no "these three cards" value, and inventing one would
        // mean a second addressing vocabulary for locks to disagree with — so a
        // multi-card reshape is declared against the first card and carries the
        // rest in its pinned set.
        const oneEditForAll = mode !== 'REPRICE' && selectedCardIds.length > 1;
        const groups = oneEditForAll ? [selectedCardIds] : selectedCardIds.map((id) => [id]);
        for (const group of groups) {
          const res = await startLedgerEdit(
            estimateId,
            { scope: 'CARD', id: group[0]! },
            [...selectedRoles],
            prompt,
            renderedAt,
            mode,
            group.length > 1 ? group : undefined,
          );
          if (!res.ok) {
            flashError(new Error(res.reason));
            continue;
          }
          if (res.staleWarning) flashError(new Error(res.staleWarning));
          setEdits((prev) => [res.edit, ...prev.filter((e) => e.id !== res.edit.id)]);
        }
        clearSelection();
        poll();
      } catch (e) {
        flashError(e);
      } finally {
        setEditBusy(false);
      }
    },
    [estimateId, selectedCardIds, selectedRoles, renderedAt, flashError, clearSelection, poll],
  );

  // ── The statement axis ─────────────────────────────────────────────────────
  const toggleStatementSelected = useCallback(
    (statementId: string, kind: 'NARRATIVE' | 'ASSUMPTION') => {
      setSelectedStatementIds((prev) => {
        // Ticking in the other list MOVES the selection. See the note on the
        // type: two documents, two boundaries, never one instruction about both.
        if (statementKind !== null && statementKind !== kind) return [statementId];
        return prev.includes(statementId)
          ? prev.filter((id) => id !== statementId)
          : [...prev, statementId];
      });
      setStatementKind(kind);
    },
    [statementKind],
  );

  const clearStatementSelection = useCallback(() => {
    setSelectedStatementIds([]);
    setStatementKind(null);
  }, []);

  const onLockStatement = useCallback(
    (target: StatementTargetDTO) => {
      setLockBusy(true);
      void (async () => {
        try {
          applyLockResult(await lockStatementRegion(estimateId, target));
        } catch (e) {
          flashError(e);
        } finally {
          setLockBusy(false);
        }
      })();
    },
    [estimateId, applyLockResult, flashError],
  );

  const onUnlockStatement = useCallback(
    (target: StatementTargetDTO, override = false) => {
      setLockBusy(true);
      void (async () => {
        try {
          applyLockResult(await unlockStatementRegion(estimateId, target, override));
        } catch (e) {
          flashError(e);
        } finally {
          setLockBusy(false);
        }
      })();
    },
    [estimateId, applyLockResult, flashError],
  );

  const onSteerStatements = useCallback(
    async (prompt: string) => {
      if (selectedStatementIds.length === 0) {
        flashError(new Error('Tick at least one line first.'));
        return;
      }
      setEditBusy(true);
      try {
        // ONE edit over every ticked line, unlike the hours path's one-per-card.
        // "These three assumptions overlap" is a single request about three
        // lines: split into three, no call could merge them and each would be
        // free to write the same sentence.
        const res = await startStatementEdit(
          estimateId,
          { scope: 'STATEMENT', id: selectedStatementIds[0]! },
          prompt,
          renderedAt,
          selectedStatementIds.length > 1 ? selectedStatementIds : undefined,
        );
        if (!res.ok) {
          flashError(new Error(res.reason));
          return;
        }
        if (res.staleWarning) flashError(new Error(res.staleWarning));
        setEdits((prev) => [res.edit, ...prev.filter((e) => e.id !== res.edit.id)]);
        clearStatementSelection();
        poll();
      } catch (e) {
        flashError(e);
      } finally {
        setEditBusy(false);
      }
    },
    [estimateId, selectedStatementIds, renderedAt, flashError, clearStatementSelection, poll],
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
    markCounts: counts,
    activeMark,
    setActiveMark,
    isCardDimmed,
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
    selectedCardIds,
    selectedRoles,
    toggleCardSelected,
    toggleRoleSelected,
    clearSelection,
    edits,
    editCounts,
    editBusy,
    onSteer,
    setEdits,
    statementKind,
    selectedStatementIds,
    toggleStatementSelected,
    clearStatementSelection,
    onLockStatement,
    onUnlockStatement,
    onSteerStatements,
  };

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>;
}
