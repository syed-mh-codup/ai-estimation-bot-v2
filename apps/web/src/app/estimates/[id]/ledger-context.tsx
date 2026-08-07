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
  type ItemDTO,
  type SectionDTO,
  type LineItemDTO,
} from './actions';

export const ROLES = ['DEV', 'QA', 'PM', 'BA'] as const;
export type Role = (typeof ROLES)[number];
export const UNGROUPED = '__ungrouped__';
export type TaxPercents = Record<Role, number>;

const snap = (h: number) => Math.max(0, Math.round(h * 4) / 4);
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
  taxPercents: TaxPercents;
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
  taxPercents,
  isFinalised,
  estimateId,
  children,
}: {
  initialSections: SectionDTO[];
  initialItems: ItemDTO[];
  taxPercents: TaxPercents;
  isFinalised: boolean;
  estimateId: string;
  children: ReactNode;
}) {
  const [sections, setSections] = useState<SectionDTO[]>(initialSections);
  const [items, setItems] = useState<ItemDTO[]>(initialItems);
  const [error, setError] = useState<string | null>(null);

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

    for (const it of items) {
      lineItemCount += it.lineItems.length;
      if (!it.enabled) {
        excluded += itemTaxed(it);
        continue;
      }
      itemsOn += 1;
      for (const li of it.lineItems) {
        if ((ROLES as readonly string[]).includes(li.role)) {
          totals[li.role as Role] += li.taxedHours;
          grand += li.taxedHours;
        }
      }
    }
    return { totals, grand, excluded, itemsOn, itemsOff: items.length - itemsOn, lineItemCount };
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
    const base = snap(Number.isFinite(raw) ? raw : 0);
    if (base === li.baseHours) return;
    const taxed = snap(base * (1 + (taxPercents[li.role as Role] ?? 0) / 100));
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

  const value: Ledger = {
    sections,
    items,
    taxPercents,
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
  };

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>;
}
