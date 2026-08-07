'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { Button } from '@/components/ui/button';
import { InlineText } from '@/components/ui/input';
import type { ItemDTO, SectionDTO, LineItemDTO } from './actions';
import {
  ROLES,
  UNGROUPED,
  byRole,
  itemTaxed,
  round,
  useLedger,
  type Role,
  type TaxPercents,
} from './ledger-context';
import { SideTag } from './SideTag';

/**
 * The ledger's column template, shared by every section head and item row. This
 * is the whole point of the screen: per-role columns on every row mean a
 * 500-hour estimate can be read down a column instead of expanded one node at a
 * time.
 *
 * Below `sm` the four role columns collapse to zero and only Total survives.
 */
const COLS =
  'grid grid-cols-[minmax(0,1fr)_0px_0px_0px_0px_72px] sm:grid-cols-[minmax(0,1fr)_52px_52px_52px_52px_66px] lg:grid-cols-[minmax(0,1fr)_66px_66px_66px_66px_84px] gap-1.5';
/** Role cells hide with their column below `sm`. */
const ROLE_CELL = 'hidden sm:block';

export function MenuCardEditor({ estimateId }: { estimateId: string }) {
  const {
    items,
    sectionsSorted,
    itemsIn,
    containerOf,
    taxPercents,
    isFinalised,
    error,
    setItems,
    onAddSection,
    onMoveItem,
  } = useLedger();

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

  // Respond to the page-level "collapse/expand all" control.
  useEffect(() => {
    const onAll = (e: Event) => {
      const wantCollapsed = (e as CustomEvent<{ collapsed: boolean }>).detail?.collapsed;
      const next = wantCollapsed
        ? new Set<string>([
            'root',
            `sec:${UNGROUPED}`,
            ...sectionsSorted.map((s) => `sec:${s.id}`),
            ...items.map((i) => `item:${i.id}`),
          ])
        : new Set<string>();
      setCollapsed(next);
      try {
        window.localStorage.setItem(collapseKey, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('estimate:collapse-all', onAll);
    return () => window.removeEventListener('estimate:collapse-all', onAll);
  }, [sectionsSorted, items, collapseKey]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
    setItems(
      items.map((it) => (it.id === active.id ? { ...it, sectionId: targetSectionId } : it)),
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
    onMoveItem(
      String(active.id),
      targetSectionId,
      reordered.map((i) => i.id),
    );
  };

  const activeItem = activeId ? (items.find((i) => i.id === activeId) ?? null) : null;
  const rootCollapsed = collapsed.has('root');
  const ungrouped = itemsIn(null);
  const isEmpty = items.length === 0 && sectionsSorted.length === 0;

  const shared = { collapsed, onToggleCollapse: toggleCollapse };

  const editorBody = (
    <div className="mt-3 space-y-3" data-testid="menu-card-body">
      {sectionsSorted.map((section) => (
        <SectionGroup key={section.id} section={section} items={itemsIn(section.id)} {...shared} />
      ))}

      {/* Ungrouped bucket — always a drop target so items can leave sections. */}
      {(ungrouped.length > 0 || sectionsSorted.length > 0 || !isFinalised) && (
        <SectionGroup
          section={{ id: UNGROUPED, title: 'Ungrouped', order: Number.MAX_SAFE_INTEGER }}
          items={ungrouped}
          isUngrouped
          {...shared}
        />
      )}

      {!isFinalised && (
        <Button variant="dashed" size="sm" onClick={onAddSection} data-testid="add-section">
          <Plus className="h-3.5 w-3.5" /> Add section
        </Button>
      )}
    </div>
  );

  return (
    <section className="mt-4 scroll-mt-4" id="menucard" data-testid="menu-card">
      <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={() => toggleCollapse('root')}
          aria-expanded={!rootCollapsed}
          className="flex flex-1 items-center gap-2 text-left"
          data-testid="menu-card-toggle"
        >
          <ChevronRight
            className={cn('h-4 w-4 text-ink-4 transition-transform', !rootCollapsed && 'rotate-90')}
            aria-hidden
          />
          <h2 className="font-serif text-[22px] font-medium text-ink">Menu card</h2>
        </button>
      </div>

      {error && (
        <div
          className="mb-2 rounded-md border border-brick-line bg-brick-tint px-3 py-2 text-sm text-brick"
          data-testid="menu-card-error"
        >
          {error}
        </div>
      )}

      {/* An empty screen is an invitation to act, not an apology — and the
          invitation belongs where the actions are. Column heads over an empty
          table would just be furniture. */}
      {!rootCollapsed && isEmpty && (
        <div
          className="rounded-[10px] border border-dashed border-line bg-surface px-6 py-10 text-center"
          data-testid="estimate-not-run"
        >
          <div className="font-serif text-[20px] text-ink">Nothing costed yet</div>
          <p className="mx-auto mt-1.5 max-w-[400px] text-[13px] leading-relaxed text-ink-3">
            Run the crew above to draft a menu card from the statement of work, or start one by
            hand. You can edit every line either way.
          </p>
          {!isFinalised && (
            <Button className="mt-5" onClick={onAddSection} data-testid="add-section">
              <Plus className="h-3.5 w-3.5" /> Add a section
            </Button>
          )}
        </div>
      )}

      {!rootCollapsed && !isEmpty && (
        <>
          {/* Column heads carry the buffer each role attracts, stated where its
              numbers live rather than in a footnote nobody reads. */}
          <div className={cn(COLS, 'sticky top-0 z-[3] border-b border-line bg-canvas px-3.5 py-2')}>
            <div className="text-[10.5px] font-bold tracking-[0.09em] text-ink-3 uppercase">Item</div>
            {ROLES.map((r) => (
              <div
                key={r}
                className={cn(
                  ROLE_CELL,
                  'text-right text-[10.5px] font-bold tracking-[0.09em] text-ink-3 uppercase',
                )}
              >
                {r}
                {taxPercents[r] > 0 && (
                  <span className="num block text-[9.5px] font-medium tracking-normal text-ink-4 normal-case">
                    +{taxPercents[r]}%
                  </span>
                )}
              </div>
            ))}
            <div className="text-right text-[10.5px] font-bold tracking-[0.09em] text-ink-3 uppercase">
              Total
            </div>
          </div>

          {isFinalised ? (
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
                  <div className="rounded-md border border-green-line bg-surface px-3 py-2 text-sm font-medium text-ink shadow-lg">
                    {activeItem.title}
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
        </>
      )}
    </section>
  );
}

// ─── Section group ──────────────────────────────────────────────────────────────

type GroupProps = {
  section: SectionDTO;
  items: ItemDTO[];
  collapsed: Set<string>;
  onToggleCollapse: (key: string) => void;
  isUngrouped?: boolean;
};

function SectionGroup({ section, items, collapsed, onToggleCollapse, isUngrouped }: GroupProps) {
  const { isFinalised, onRenameSection, onDeleteSection, onAddItem } = useLedger();
  const containerId = isUngrouped ? UNGROUPED : section.id;
  const { setNodeRef } = useSortable({ id: containerId, data: { container: true } });
  const key = `sec:${section.id}`;
  const isCollapsed = collapsed.has(key);

  const enabled = items.filter((i) => i.enabled);
  const offCount = items.length - enabled.length;
  const subtotal = enabled.reduce((s, it) => s + itemTaxed(it), 0);
  const roleTotals = ROLES.reduce(
    (acc, r) => {
      acc[r] = enabled.reduce((s, it) => s + byRole(it)[r], 0);
      return acc;
    },
    {} as Record<Role, number>,
  );

  return (
    <div ref={setNodeRef} data-testid={isUngrouped ? 'section-ungrouped' : `section-${section.id}`}>
      <div
        className={cn(
          COLS,
          'items-center border border-line bg-surface-2 px-3.5 py-2',
          isCollapsed ? 'rounded-md' : 'rounded-t-md',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onToggleCollapse(key)}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? 'Expand section' : 'Collapse section'}
            className="shrink-0"
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 text-ink-4 transition-transform',
                !isCollapsed && 'rotate-90',
              )}
              aria-hidden
            />
          </button>
          {isUngrouped ? (
            <span className="font-serif text-[15.5px] font-semibold text-ink-3">Ungrouped</span>
          ) : (
            <InlineText
              defaultValue={section.title}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (v && v !== section.title) onRenameSection(section.id, v);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  e.currentTarget.value = section.title;
                  e.currentTarget.blur();
                }
              }}
              disabled={isFinalised}
              aria-label="Section title"
              className="-ml-1.5 font-serif text-[15.5px] font-semibold disabled:opacity-100"
              data-testid={`section-title-${section.id}`}
            />
          )}
          <span className="num shrink-0 text-[10.5px] whitespace-nowrap text-ink-4">
            {items.length} item{items.length === 1 ? '' : 's'}
            {offCount > 0 && ` · ${offCount} off`}
          </span>
          {!isFinalised && !isUngrouped && (
            <button
              type="button"
              onClick={() => onDeleteSection(section.id)}
              title="Delete section (items move to Ungrouped)"
              aria-label="Delete section"
              className="ml-1 shrink-0 rounded border border-line bg-surface p-1 text-ink-4 hover:border-brick-line hover:text-brick"
              data-testid={`delete-section-${section.id}`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>

        {ROLES.map((r) => (
          <div key={r} className={cn(ROLE_CELL, 'num text-right text-xs font-medium text-ink-2')}>
            {roleTotals[r] > 0 ? round(roleTotals[r]) : <span className="text-ink-4">—</span>}
          </div>
        ))}
        <div
          className="num text-right text-xs font-semibold text-ink"
          data-testid={`section-total-${section.id}`}
        >
          {round(subtotal)}
        </div>
      </div>

      {!isCollapsed && (
        <div className="overflow-hidden rounded-b-md border border-t-0 border-line bg-surface">
          <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <div data-empty={items.length === 0 ? 'true' : undefined}>
              {items.length === 0 ? (
                <p className="px-3.5 py-4 text-center text-xs text-ink-4">
                  {isFinalised ? 'No items.' : 'Drag items here, or add one.'}
                </p>
              ) : (
                items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    collapsed={collapsed}
                    onToggleCollapse={onToggleCollapse}
                  />
                ))
              )}
            </div>
          </SortableContext>
          {!isFinalised && (
            <div className="border-t border-line-soft px-3.5 py-2">
              <Button
                variant="dashed"
                size="xs"
                onClick={() => onAddItem(isUngrouped ? null : section.id)}
                data-testid={`add-item-${isUngrouped ? 'ungrouped' : section.id}`}
              >
                <Plus className="h-3 w-3" /> Item
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Item row ───────────────────────────────────────────────────────────────────

function ItemRow({
  item,
  collapsed,
  onToggleCollapse,
}: {
  item: ItemDTO;
  collapsed: Set<string>;
  onToggleCollapse: (key: string) => void;
}) {
  const { isFinalised, onRenameItem, onToggleItem, onDeleteItem, onAddLineItem } = useLedger();
  const sortable = useSortable({ id: item.id, disabled: isFinalised });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;
  const style = { transform: CSS.Transform.toString(transform), transition };
  const key = `item:${item.id}`;
  const isCollapsed = collapsed.has(key);
  const roles = byRole(item);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'border-b border-line-soft last:border-b-0',
        isDragging && 'opacity-40',
        // A disabled item is still priced — it just doesn't count. Hatching says
        // "excluded" without hiding numbers you might switch back on.
        !item.enabled &&
          'bg-[repeating-linear-gradient(135deg,transparent,transparent_5px,rgba(148,143,129,0.05)_5px,rgba(148,143,129,0.05)_10px)]',
      )}
      data-testid={`menu-item-${item.id}`}
    >
      <div className={cn(COLS, 'group relative items-center px-3.5 py-2 hover:bg-surface-2')}>
        <div className="flex min-w-0 items-center gap-1.5">
          {!isFinalised && (
            <button
              type="button"
              className="-ml-1.5 shrink-0 cursor-grab touch-none text-line opacity-0 group-hover:text-ink-4 group-hover:opacity-100 active:cursor-grabbing"
              aria-label="Drag to reorder"
              data-testid={`drag-${item.id}`}
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onToggleCollapse(key)}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? 'Show line items' : 'Hide line items'}
            className="shrink-0"
          >
            <ChevronRight
              className={cn('h-3 w-3 text-ink-4 transition-transform', !isCollapsed && 'rotate-90')}
              aria-hidden
            />
          </button>
          <InlineText
            defaultValue={item.title}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (v && v !== item.title) onRenameItem(item.id, v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.currentTarget.value = item.title;
                e.currentTarget.blur();
              }
            }}
            disabled={isFinalised}
            aria-label="Item title"
            className={cn(
              '-ml-1.5 text-[13.5px] font-medium disabled:opacity-100',
              !item.enabled && 'text-ink-4 line-through decoration-line',
            )}
            data-testid={`item-title-${item.id}`}
          />
          {!item.enabled && (
            <span className="shrink-0 rounded border border-line bg-surface px-1 text-[9.5px] font-bold tracking-[0.07em] text-ink-3 uppercase">
              Off
            </span>
          )}
        </div>

        {ROLES.map((r) => (
          <div
            key={r}
            className={cn(ROLE_CELL, 'num text-right text-xs', item.enabled ? 'text-ink-2' : 'text-ink-4')}
          >
            {roles[r] > 0 ? round(roles[r]) : <span className="text-ink-4">—</span>}
          </div>
        ))}
        <div
          className={cn('num text-right text-xs font-semibold', item.enabled ? 'text-ink' : 'text-ink-4')}
          data-testid={`item-total-${item.id}`}
        >
          {round(itemTaxed(item))}
        </div>

        {!isFinalised && (
          <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1 bg-surface-2 pl-2 opacity-0 group-hover:opacity-100">
            <button
              type="button"
              onClick={() => onToggleItem(item.id, !item.enabled)}
              className="rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] font-medium text-ink-3 hover:border-ink-4 hover:text-ink"
              data-testid={`toggle-item-${item.id}`}
            >
              {item.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              onClick={() => onDeleteItem(item.id)}
              title="Delete item"
              aria-label="Delete item"
              className="rounded border border-line bg-surface p-1 text-ink-4 hover:border-brick-line hover:text-brick"
              data-testid={`delete-item-${item.id}`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      {!isCollapsed && (
        <div className="border-t border-line-soft bg-surface-2 py-1">
          {item.lineItems.length === 0 && (
            <p className="px-3.5 py-2 pl-10 text-xs text-ink-4">No line items yet.</p>
          )}
          {ROLES.flatMap((role) =>
            item.lineItems
              .filter((li) => li.role === role)
              .map((li) => <LineRow key={li.id} li={li} role={role} item={item} />),
          )}
          {!isFinalised && (
            <div className="flex flex-wrap items-center gap-1.5 px-3.5 py-1.5 pl-10">
              <span className="text-[11px] text-ink-4">Add:</span>
              {ROLES.map((role) => (
                <button
                  key={role}
                  type="button"
                  onClick={() => onAddLineItem(item.id, role)}
                  className="num rounded border border-dashed border-line px-1.5 py-0.5 text-[10.5px] font-semibold text-ink-3 hover:border-green-line hover:bg-green-tint hover:text-green"
                  data-testid={`add-line-${role}-${item.id}`}
                >
                  + {role}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Line item row ──────────────────────────────────────────────────────────────

/**
 * One line item: who does the work, what it is, and what it costs.
 *
 * Line rows step out of the role-column grid on purpose. You type *base* hours
 * and the buffer is applied for you, so the row has to hold "10 +15% → 11.5" —
 * far wider than a 66px column, and in flow it would shove every column
 * sideways. The role tag carries identity instead, and the taxed figure is
 * pinned to the Total column's width so it still lands under Total.
 */
function LineRow({ li, role, item }: { li: LineItemDTO; role: Role; item: ItemDTO }) {
  const { taxPercents, isFinalised, onEditLineTitle, onSetLineSide, onEditLineHours, onDeleteLineItem } =
    useLedger();
  const pct = (taxPercents as TaxPercents)[role] ?? 0;

  return (
    <div className="group/line flex items-center gap-2 px-3.5 py-1 pl-10 hover:bg-line-soft">
      <span className="num shrink-0 rounded border border-line bg-surface px-1 text-[10px] font-semibold text-ink-3">
        {role}
      </span>

      {/* Only DEV work has a frontend/backend side; QA, PM and BA don't. */}
      {role === 'DEV' && (
        <SideTag
          li={li}
          disabled={isFinalised}
          onChange={(side) => onSetLineSide(item.id, li, side)}
        />
      )}

      <InlineText
        defaultValue={li.title ?? ''}
        placeholder="Describe this work…"
        onBlur={(e) => onEditLineTitle(item.id, li, e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.currentTarget.value = li.title ?? '';
            e.currentTarget.blur();
          }
        }}
        disabled={isFinalised}
        aria-label={`${role} line item title`}
        className="min-w-0 flex-1 text-[12.5px] text-ink-2 disabled:opacity-100"
        data-testid={`line-title-${li.id}`}
      />

      {/* A human overrode the crew's number here. */}
      {li.edited && (
        <span
          title="Edited by hand"
          className="shrink-0 text-[9.5px] font-bold tracking-[0.06em] text-ink-4 uppercase"
        >
          edited
        </span>
      )}

      {!isFinalised && (
        <button
          type="button"
          onClick={() => onDeleteLineItem(item.id, li.id)}
          title="Delete line item"
          aria-label="Delete line item"
          className="shrink-0 px-1 text-ink-4 opacity-0 group-hover/line:opacity-100 hover:text-brick"
          data-testid={`delete-line-${li.id}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}

      {!isFinalised && (
        <input
          type="number"
          step="0.25"
          min="0"
          defaultValue={li.baseHours}
          onBlur={(e) => onEditLineHours(item.id, li, Number(e.currentTarget.value))}
          aria-label={`${role} base hours`}
          className="num w-[54px] shrink-0 rounded border border-line bg-surface px-1.5 py-0.5 text-right text-xs text-ink focus:border-green focus:outline-none"
          data-testid={`base-${role}-${item.id}-${li.id}`}
        />
      )}

      {/* Only worth showing where a buffer actually changes the number. */}
      {pct > 0 && !isFinalised && (
        <span className="num hidden shrink-0 text-[10px] whitespace-nowrap text-ink-4 lg:inline">
          +{pct}% →
        </span>
      )}

      <span
        className={cn(
          'num w-[72px] shrink-0 text-right text-xs sm:w-[66px] lg:w-[84px]',
          pct > 0 ? 'font-semibold text-green' : 'text-ink-3',
        )}
        data-testid={`taxed-${role}-${item.id}-${li.id}`}
      >
        {round(li.taxedHours)}
      </span>
    </div>
  );
}
