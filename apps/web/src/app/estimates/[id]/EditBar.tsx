'use client';

import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ROLES, useLedger, type Role } from './ledger-context';

/**
 * The edit envelope's control surface — AEH-238.
 *
 * Appears only once something is selected, and sits at the BOTTOM of the ledger
 * rather than in the sticky rail. AEH-302 already records that the rail is a
 * fixed stack that keeps growing and buries its actions, and this would be the
 * heaviest thing in it.
 *
 * What it is for is worth stating plainly, because it looks like a chat box and
 * is not one. The person has already decided what may change — that is the
 * ticks and the role chips, and it is enforced mechanically. The text only says
 * what should happen inside that boundary. Nothing typed here can widen it.
 */
export function EditBar() {
  const {
    items,
    selectedCardIds,
    selectedRoles,
    toggleRoleSelected,
    clearSelection,
    onSteer,
    editBusy,
    isFinalised,
    locks,
  } = useLedger();
  const [prompt, setPrompt] = useState('');

  if (isFinalised || selectedCardIds.length === 0) return null;

  const selectedCards = items.filter((i) => selectedCardIds.includes(i.id));
  // How many rows the declaration actually covers, counted from what is on
  // screen. The server resolves it again — this is the number that makes the
  // blast radius legible before anybody commits to it.
  const rowCount = selectedCards.reduce(
    (n, card) =>
      n + card.lineItems.filter((li) => selectedRoles.includes(li.role as Role)).length,
    0,
  );
  // A locked row inside the declaration means the whole thing will be refused,
  // so say it here rather than after the click.
  const lockedInSelection = selectedCards.reduce(
    (n, card) =>
      n +
      card.lineItems.filter(
        (li) => selectedRoles.includes(li.role as Role) && locks.lines[li.id] !== undefined,
      ).length,
    0,
  );
  const ready = selectedRoles.length > 0 && rowCount > 0 && lockedInSelection === 0;

  return (
    <div
      className="sticky bottom-0 z-10 mt-3 rounded-[10px] border border-green/40 bg-surface px-4 py-3 shadow-sm"
      data-testid="edit-bar"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="eyebrow text-ink-4">Change</span>

        <span className="num text-[12px] text-ink-2" data-testid="edit-scope">
          {selectedCards.length} card{selectedCards.length === 1 ? '' : 's'}
        </span>

        <div className="flex items-center gap-1">
          {ROLES.map((role) => {
            const on = selectedRoles.includes(role);
            return (
              <button
                key={role}
                type="button"
                onClick={() => toggleRoleSelected(role)}
                aria-pressed={on}
                className={cn(
                  'num rounded border px-1.5 py-0.5 text-[10.5px] font-semibold',
                  on
                    ? 'border-green bg-green/10 text-green'
                    : 'border-line bg-surface text-ink-4 hover:text-ink-2',
                )}
                data-testid={`edit-role-${role}`}
              >
                {role}
              </button>
            );
          })}
        </div>

        <span className="num text-[11.5px] text-ink-4" data-testid="edit-row-count">
          {selectedRoles.length === 0
            ? 'pick a role'
            : `${rowCount} line${rowCount === 1 ? '' : 's'} may change`}
        </span>

        <button
          type="button"
          onClick={clearSelection}
          className="ml-auto flex items-center gap-1 text-[11.5px] text-ink-4 hover:text-ink-2"
          data-testid="edit-clear"
        >
          <X className="h-3 w-3" aria-hidden /> Clear
        </button>
      </div>

      {lockedInSelection > 0 && (
        <p className="mt-1.5 text-[11.5px] text-bronze-ink" data-testid="edit-locked-warning">
          {lockedInSelection} line{lockedInSelection === 1 ? ' is' : 's are'} locked inside this
          selection, so it would be refused. Narrow it, or unlock them.
        </p>
      )}

      <div className="mt-2 flex items-start gap-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. A steer is usually one
            // sentence, and reaching for the mouse to send it is friction the
            // whole feature exists to remove.
            if (e.key === 'Enter' && !e.shiftKey && ready && !editBusy) {
              e.preventDefault();
              void onSteer(prompt).then(() => setPrompt(''));
            }
          }}
          rows={2}
          placeholder="The work described is right but the hours are too heavy — re-think it."
          aria-label="What should change inside the selection"
          className="min-w-0 flex-1 resize-y rounded border border-line bg-surface px-2 py-1.5 text-[12.5px] text-ink placeholder:text-ink-4 focus:border-green focus:outline-none"
          data-testid="edit-prompt"
        />
        <Button
          type="button"
          size="sm"
          disabled={!ready || editBusy || prompt.trim().length === 0}
          onClick={() => void onSteer(prompt).then(() => setPrompt(''))}
          data-testid="edit-submit"
        >
          <Sparkles className="h-3 w-3" /> {editBusy ? 'Starting…' : 'Re-price'}
        </Button>
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-ink-4">
        The council re-prices only what is ticked above, against the same requirement it costed
        first time. It can read the rest of the estimate; it cannot change it.
      </p>
    </div>
  );
}
