'use client';

import { MoreVertical } from 'lucide-react';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { askOracle } from './oracle-bus';
import { ROLES, useLedger, type Role } from './ledger-context';
import type { ItemDTO } from './dto';

/**
 * Everything you can do to one card, behind a glyph that is always drawn.
 *
 * What this replaces is the point. Disable, Delete, the drag grip and Ask
 * Oracle were four separate hover-only controls, so a row at rest advertised
 * none of what could be done to it — you had to already know. On a touch screen
 * there is no hover at all, and the Disable/Delete pair lived in an absolutely
 * positioned strip that covered this row's own numbers while it was open.
 *
 * One always-visible glyph costs the row about 20px, which the overlay was
 * already taking, and buys discoverability, a keyboard path, and the numbers
 * back. AEH-377.
 *
 * The drag grip is the one thing NOT folded in here, and it stays hover-only.
 * It is a handle rather than a command — there is nothing for a menu item to
 * do — and dnd-kit's keyboard sensor already reaches it on focus, so the
 * keyboard is served. Reordering by menu would need a target picker this screen
 * does not have.
 */
export function CardMenu({
  item,
  lockedOff,
  onAddLineItem,
}: {
  item: ItemDTO;
  /** Other scope depends on this card, so switching it off is refused. */
  lockedOff: boolean;
  onAddLineItem: (menuItemId: string, role: Role) => Promise<void>;
}) {
  const { onToggleItem, onDeleteItem, onLock, locks, onUnlock, viewerId } = useLedger();

  const fullyLocked = locks.cardsFullyLocked.includes(item.id);
  const anyLocked = fullyLocked || locks.cardsWithAnyLock.includes(item.id);
  // Releasing your own lock is one click; taking somebody else's is not this
  // menu's business — the padlock on the row carries that confirmation.
  const minesToRelease = anyLocked && item.lineItems.every((li) => {
    const lock = locks.lines[li.id];
    return lock === undefined || lock.lockedById === viewerId;
  });

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${item.title}`}
          className="shrink-0 rounded p-0.5 text-ink-4 transition-colors hover:text-ink focus-visible:ring-1 focus-visible:ring-green focus-visible:outline-none"
          data-testid={`card-menu-${item.id}`}
        >
          <MoreVertical className="h-3.5 w-3.5" aria-hidden />
        </button>
      </MenuTrigger>

      <MenuContent align="end">
        <MenuItem
          // Switching a card back ON is never gated — the judgment is about
          // removing scope something else stands on, not about adding it.
          //
          // A ledger lock does NOT gate this, in either direction. It says a
          // line's hours and description are settled; switching the card in or
          // out of the estimate changes neither. See lock-guards.ts.
          disabled={item.enabled && lockedOff}
          onSelect={() => onToggleItem(item.id, !item.enabled)}
          data-testid={`toggle-item-${item.id}`}
        >
          {item.enabled ? 'Switch off' : 'Switch on'}
          {item.enabled && lockedOff && (
            <span className="ml-auto text-[11px] text-ink-4">other scope needs it</span>
          )}
        </MenuItem>

        <MenuItem
          onSelect={() =>
            anyLocked && minesToRelease
              ? onUnlock({ scope: 'CARD', id: item.id }, [...ROLES])
              : onLock({ scope: 'CARD', id: item.id }, [...ROLES])
          }
          data-testid={`card-menu-lock-${item.id}`}
        >
          {anyLocked && minesToRelease ? 'Unlock this card' : 'Lock this card'}
        </MenuItem>

        <MenuItem
          onSelect={() =>
            askOracle({
              question: `Explain the menu card "${item.title}" (${item.taxonomyKey}). What in the source material drove it, and where did its hours come from?`,
            })
          }
          data-testid={`ask-oracle-item-${item.id}`}
        >
          Ask Oracle about it
        </MenuItem>

        <MenuSeparator />

        {/* The four "+ ROLE" buttons at the foot of an expanded card are still
            there and still faster. This is the path for a collapsed card, which
            previously had no way to gain a line at all without opening it. */}
        {ROLES.map((role) => (
          <MenuItem
            key={role}
            onSelect={() => void onAddLineItem(item.id, role)}
            data-testid={`card-menu-add-${role}-${item.id}`}
          >
            <span className="num text-[11px] font-semibold text-ink-3">{role}</span>
            Add a line
          </MenuItem>
        ))}

        <MenuSeparator />

        <MenuItem tone="danger" onSelect={() => onDeleteItem(item.id)} data-testid={`delete-item-${item.id}`}>
          Delete this card
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
