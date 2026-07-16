'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronRight, GripVertical, Plus, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
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
  deleteLineItem,
  type ItemDTO,
  type SectionDTO,
  type LineItemDTO,
} from './actions';

const ROLES = ['DEV', 'QA', 'PM', 'BA'] as const;
type Role = (typeof ROLES)[number];
const UNGROUPED = '__ungrouped__';

type TaxPercents = Record<Role, number>;

export type MenuCardEditorProps = {
  estimateId: string;
  initialSections: SectionDTO[];
  initialItems: ItemDTO[];
  taxPercents: TaxPercents;
  isFinalised: boolean;
};

// ─── helpers ──────────────────────────────────────────────────────────────────

const snap = (h: number) => Math.max(0, Math.round(h * 4) / 4);
const itemTaxed = (it: ItemDTO) => it.lineItems.reduce((s, li) => s + li.taxedHours, 0);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

export function MenuCardEditor({
  estimateId,
  initialSections,
  initialItems,
  taxPercents,
  isFinalised,
}: MenuCardEditorProps) {
  const [sections, setSections] = useState<SectionDTO[]>(initialSections);
  const [items, setItems] = useState<ItemDTO[]>(initialItems);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Collapse state (root / per-section / per-item), persisted in localStorage.
  const collapseKey = `mc-collapsed:${estimateId}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(collapseKey);
      if (raw) setCollapsed(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore */
    }
  }, [collapseKey]);
  const toggleCollapse = useCallback(
    (key: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        try {
          window.localStorage.setItem(collapseKey, JSON.stringify([...next]));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [collapseKey],
  );

  const errTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashError = useCallback((e: unknown) => {
    setError(errMsg(e));
    if (errTimer.current) clearTimeout(errTimer.current);
    errTimer.current = setTimeout(() => setError(null), 4500);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Ordered helpers.
  const sectionsSorted = useMemo(
    () => [...sections].sort((a, b) => a.order - b.order),
    [sections],
  );
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

  // Live roll-up (enabled items only), mirrors the server-side rollup.
  const rollup = useMemo(() => {
    const totals: Record<Role, number> = { DEV: 0, QA: 0, PM: 0, BA: 0 };
    let grand = 0;
    for (const it of items) {
      if (!it.enabled) continue;
      for (const li of it.lineItems) {
        if ((ROLES as readonly string[]).includes(li.role)) {
          totals[li.role as Role] += li.taxedHours;
          grand += li.taxedHours;
        }
      }
    }
    return { totals, grand };
  }, [items]);

  // ── optimistic mutation helper ──
  const optimistic = useCallback(
    async (apply: () => void, revertTo: { s: SectionDTO[]; i: ItemDTO[] }, server: () => Promise<void>) => {
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

  // ── Drag & drop (items between/within sections) ──
  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    const activeContainer = containerOf(String(active.id));
    const overContainer = containerOf(String(over.id));
    if (!activeContainer || !overContainer || activeContainer === overContainer) return;
    // Move the dragged item into the container it's now hovering.
    const targetSectionId = overContainer === UNGROUPED ? null : overContainer;
    setItems((prev) =>
      prev.map((it) => (it.id === active.id ? { ...it, sectionId: targetSectionId } : it)),
    );
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const overContainer = containerOf(String(over.id));
    if (!overContainer) return;
    const targetSectionId = overContainer === UNGROUPED ? null : overContainer;

    const inContainer = items
      .filter((i) => (i.sectionId ?? null) === targetSectionId)
      .sort((a, b) => a.order - b.order);
    const oldIndex = inContainer.findIndex((i) => i.id === active.id);
    let newIndex = inContainer.findIndex((i) => i.id === over.id);
    if (newIndex === -1) newIndex = inContainer.length - 1; // dropped on the container itself
    if (oldIndex === -1) return;

    const reordered = arrayMove(inContainer, oldIndex, newIndex);
    const orderedIds = reordered.map((i) => i.id);
    const snap0 = snapshot();

    // Apply new order locally.
    setItems((prev) =>
      prev.map((it) => {
        const idx = orderedIds.indexOf(it.id);
        if (idx === -1) return it.sectionId === targetSectionId ? it : it;
        return { ...it, sectionId: targetSectionId, order: idx };
      }),
    );

    moveMenuItem(String(active.id), targetSectionId, orderedIds).catch((err) => {
      setSections(snap0.s);
      setItems(snap0.i);
      flashError(err);
    });
  };

  const activeItem = activeId ? items.find((i) => i.id === activeId) ?? null : null;
  const rootCollapsed = collapsed.has('root');
  const ungrouped = itemsIn(null);

  const editorBody = (
    <div className="mt-3 space-y-4" data-testid="menu-card-body">
      {sectionsSorted.map((section) => (
        <SectionGroup
          key={section.id}
          section={section}
          items={itemsIn(section.id)}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          taxPercents={taxPercents}
          isFinalised={isFinalised}
          onRenameSection={onRenameSection}
          onDeleteSection={onDeleteSection}
          onAddItem={onAddItem}
          onRenameItem={onRenameItem}
          onToggleItem={onToggleItem}
          onDeleteItem={onDeleteItem}
          onAddLineItem={onAddLineItem}
          onEditLineTitle={onEditLineTitle}
          onEditLineHours={onEditLineHours}
          onDeleteLineItem={onDeleteLineItem}
        />
      ))}

      {/* Ungrouped bucket — always a drop target so items can leave sections. */}
      {(ungrouped.length > 0 || sectionsSorted.length > 0 || !isFinalised) && (
        <SectionGroup
          section={{ id: UNGROUPED, title: 'Ungrouped', order: Number.MAX_SAFE_INTEGER }}
          items={ungrouped}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          taxPercents={taxPercents}
          isFinalised={isFinalised}
          isUngrouped
          onRenameSection={onRenameSection}
          onDeleteSection={onDeleteSection}
          onAddItem={onAddItem}
          onRenameItem={onRenameItem}
          onToggleItem={onToggleItem}
          onDeleteItem={onDeleteItem}
          onAddLineItem={onAddLineItem}
          onEditLineTitle={onEditLineTitle}
          onEditLineHours={onEditLineHours}
          onDeleteLineItem={onDeleteLineItem}
        />
      )}

      {!isFinalised && (
        <button
          type="button"
          onClick={onAddSection}
          className="flex items-center gap-1 rounded-md border border-dashed border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-gray-400 hover:text-gray-800"
          data-testid="add-section"
        >
          <Plus className="h-3.5 w-3.5" /> Add section
        </button>
      )}
    </div>
  );

  return (
    <section className="mt-6" data-testid="menu-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => toggleCollapse('root')}
          aria-expanded={!rootCollapsed}
          className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700"
          data-testid="menu-card-toggle"
        >
          <ChevronRight
            className={cn('h-4 w-4 transition-transform', !rootCollapsed && 'rotate-90')}
            aria-hidden
          />
          Menu Card
        </button>
        <div className="text-sm text-gray-600" data-testid="rollup-totals">
          {ROLES.map((r) => (
            <span key={r} className="ml-3" data-testid={`total-${r}`}>
              {r} {round(rollup.totals[r])}
            </span>
          ))}
          <span className="ml-3 font-semibold text-gray-900" data-testid="total-all">
            Total {round(rollup.grand)}h
          </span>
        </div>
      </div>

      {error && (
        <div
          className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          data-testid="menu-card-error"
        >
          {error}
        </div>
      )}

      {!rootCollapsed &&
        (isFinalised ? (
          editorBody
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
          >
            {editorBody}
            <DragOverlay>
              {activeItem ? (
                <div className="rounded-md border border-indigo-300 bg-white px-3 py-2 text-sm font-medium text-gray-900 shadow-lg">
                  {activeItem.title}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        ))}
    </section>
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Section group ──────────────────────────────────────────────────────────────

type SectionGroupProps = {
  section: SectionDTO;
  items: ItemDTO[];
  collapsed: Set<string>;
  onToggleCollapse: (key: string) => void;
  taxPercents: TaxPercents;
  isFinalised: boolean;
  isUngrouped?: boolean;
  onRenameSection: (id: string, title: string) => void;
  onDeleteSection: (id: string) => void;
  onAddItem: (sectionId: string | null) => void;
  onRenameItem: (id: string, title: string) => void;
  onToggleItem: (id: string, enabled: boolean) => void;
  onDeleteItem: (id: string) => void;
  onAddLineItem: (menuItemId: string, role: Role) => void;
  onEditLineTitle: (menuItemId: string, li: LineItemDTO, title: string) => void;
  onEditLineHours: (menuItemId: string, li: LineItemDTO, raw: number) => void;
  onDeleteLineItem: (menuItemId: string, id: string) => void;
};

function SectionGroup(props: SectionGroupProps) {
  const { section, items, collapsed, onToggleCollapse, isFinalised, isUngrouped } = props;
  const containerId = isUngrouped ? UNGROUPED : section.id;
  const { setNodeRef } = useSortable({ id: containerId, data: { container: true } });
  const key = `sec:${section.id}`;
  const isCollapsed = collapsed.has(key);
  const subtotal = items.reduce((s, it) => (it.enabled ? s + itemTaxed(it) : s), 0);

  return (
    <div
      ref={setNodeRef}
      className="rounded-lg border border-gray-200 bg-gray-50/60 p-3"
      data-testid={isUngrouped ? 'section-ungrouped' : `section-${section.id}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onToggleCollapse(key)}
          aria-expanded={!isCollapsed}
          className="flex flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            className={cn('h-4 w-4 shrink-0 text-gray-400 transition-transform', !isCollapsed && 'rotate-90')}
            aria-hidden
          />
          {isUngrouped ? (
            <span className="text-sm font-semibold text-gray-500">Ungrouped</span>
          ) : (
            <InlineText
              value={section.title}
              onCommit={(t) => props.onRenameSection(section.id, t)}
              disabled={isFinalised}
              className="text-sm font-semibold text-gray-800"
              data-testid={`section-title-${section.id}`}
            />
          )}
        </button>
        <span className="text-xs text-gray-500" data-testid={`section-total-${section.id}`}>
          {round(subtotal)}h
        </span>
        {!isFinalised && (
          <>
            <button
              type="button"
              onClick={() => props.onAddItem(isUngrouped ? null : section.id)}
              title="Add item"
              className="flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
              data-testid={`add-item-${isUngrouped ? 'ungrouped' : section.id}`}
            >
              <Plus className="h-3.5 w-3.5" /> Item
            </button>
            {!isUngrouped && (
              <button
                type="button"
                onClick={() => props.onDeleteSection(section.id)}
                title="Delete section (items move to Ungrouped)"
                className="rounded-md border border-gray-300 bg-white p-1 text-gray-400 hover:border-red-200 hover:text-red-600"
                data-testid={`delete-section-${section.id}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        )}
      </div>

      {!isCollapsed && (
        <div className="mt-2">
          <SortableContext
            items={items.map((i) => i.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-2" data-empty={items.length === 0 ? 'true' : undefined}>
              {items.length === 0 ? (
                <p className="rounded-md border border-dashed border-gray-200 px-3 py-3 text-center text-xs text-gray-400">
                  {isFinalised ? 'No items.' : 'Drag items here, or use “+ Item”.'}
                </p>
              ) : (
                items.map((item) => (
                  <SortableItemCard key={item.id} item={item} {...props} />
                ))
              )}
            </div>
          </SortableContext>
        </div>
      )}
    </div>
  );
}

// ─── Sortable item card ─────────────────────────────────────────────────────────

function SortableItemCard(props: SectionGroupProps & { item: ItemDTO }) {
  const { item, collapsed, onToggleCollapse, isFinalised } = props;
  const sortable = useSortable({ id: item.id, disabled: isFinalised });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;
  const style = { transform: CSS.Transform.toString(transform), transition };
  const key = `item:${item.id}`;
  const isCollapsed = collapsed.has(key);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-md border bg-white',
        item.enabled ? 'border-gray-200' : 'border-gray-200 bg-gray-50 opacity-60',
        isDragging && 'opacity-40',
      )}
      data-testid={`menu-item-${item.id}`}
    >
      <div className="flex items-center gap-2 p-3">
        {!isFinalised && (
          <button
            type="button"
            className="cursor-grab touch-none text-gray-300 hover:text-gray-500 active:cursor-grabbing"
            aria-label="Drag to reorder"
            data-testid={`drag-${item.id}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onToggleCollapse(key)}
          aria-expanded={!isCollapsed}
          className="shrink-0 text-gray-400 hover:text-gray-600"
        >
          <ChevronRight className={cn('h-4 w-4 transition-transform', !isCollapsed && 'rotate-90')} />
        </button>
        <div className="min-w-0 flex-1">
          <InlineText
            value={item.title}
            onCommit={(t) => props.onRenameItem(item.id, t)}
            disabled={isFinalised}
            className="font-medium text-gray-900"
            data-testid={`item-title-${item.id}`}
          />
        </div>
        <span className="text-xs text-gray-500" data-testid={`item-total-${item.id}`}>
          {round(itemTaxed(item))}h
        </span>
        {!isFinalised && (
          <>
            <button
              type="button"
              onClick={() => props.onToggleItem(item.id, !item.enabled)}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
              data-testid={`toggle-item-${item.id}`}
            >
              {item.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              onClick={() => props.onDeleteItem(item.id)}
              title="Delete item"
              className="rounded-md border border-gray-300 p-1 text-gray-400 hover:border-red-200 hover:text-red-600"
              data-testid={`delete-item-${item.id}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      {!isCollapsed && (
        <div className="space-y-2 border-t border-gray-100 px-3 py-2">
          {ROLES.map((role) => {
            const lines = item.lineItems.filter((li) => li.role === role);
            const subtotal = lines.reduce((s, li) => s + li.taxedHours, 0);
            return (
              <div key={role} className="text-xs text-gray-600">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-700">{role}</span>
                  <span className="text-gray-400">{round(subtotal)}h</span>
                  {!isFinalised && (
                    <button
                      type="button"
                      onClick={() => props.onAddLineItem(item.id, role)}
                      className="ml-1 inline-flex items-center gap-0.5 text-gray-400 hover:text-indigo-600"
                      data-testid={`add-line-${role}-${item.id}`}
                    >
                      <Plus className="h-3 w-3" /> line item
                    </button>
                  )}
                </div>
                {lines.length > 0 && (
                  <div className="mt-1 space-y-1">
                    {lines.map((li) => (
                      <div key={li.id} className="ml-2 flex flex-wrap items-center gap-2">
                        <InlineText
                          value={li.title ?? ''}
                          placeholder="Describe this work…"
                          onCommit={(t) => props.onEditLineTitle(item.id, li, t)}
                          disabled={isFinalised}
                          className="min-w-0 flex-1 text-gray-600"
                          data-testid={`line-title-${li.id}`}
                        />
                        <input
                          type="number"
                          step="0.25"
                          min="0"
                          defaultValue={li.baseHours}
                          disabled={isFinalised}
                          onBlur={(e) => props.onEditLineHours(item.id, li, Number(e.target.value))}
                          className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm disabled:opacity-40"
                          data-testid={`base-${role}-${item.id}-${li.id}`}
                        />
                        <span className="text-gray-400" data-testid={`taxed-${role}-${item.id}-${li.id}`}>
                          → {round(li.taxedHours)}h
                        </span>
                        {!isFinalised && (
                          <button
                            type="button"
                            onClick={() => props.onDeleteLineItem(item.id, li.id)}
                            title="Delete line item"
                            className="text-gray-300 hover:text-red-600"
                            data-testid={`delete-line-${li.id}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Inline editable text ───────────────────────────────────────────────────────

function InlineText({
  value,
  onCommit,
  disabled,
  placeholder,
  className,
  'data-testid': testId,
}: {
  value: string;
  onCommit: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  'data-testid'?: string;
}) {
  const [draft, setDraft] = useState(value);
  // Keep in sync if the value changes underneath us (e.g. server reconcile).
  useEffect(() => setDraft(value), [value]);

  if (disabled) {
    return (
      <span className={cn('block truncate', className)} data-testid={testId}>
        {value || <span className="text-gray-400">{placeholder ?? '—'}</span>}
      </span>
    );
  }
  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={cn(
        'w-full rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-gray-200 focus:border-indigo-300 focus:bg-white focus:outline-none',
        className,
      )}
      data-testid={testId}
    />
  );
}
