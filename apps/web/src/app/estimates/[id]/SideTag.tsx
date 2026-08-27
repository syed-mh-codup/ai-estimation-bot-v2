'use client';

import type { LineItemDTO } from './dto';

/**
 * Which side of the stack a DEV line item touches.
 *
 * Two independent toggles rather than a three-way picker, because that is what
 * the data is: `touchesFrontend` and `touchesBackend` are separate booleans, so
 * all four states — backend, frontend, both, untagged — are reachable by
 * clicking the thing you mean. A dropdown would hide "untagged" behind an
 * awkward empty option and make "both" feel like a third category rather than
 * what it is: both of these, on.
 *
 * Deliberately NOT near the hours. The hours are one combined number and these
 * flags never divide it; sitting them beside the figure would imply otherwise.
 */
export function SideTag({
  li,
  disabled,
  onChange,
}: {
  li: LineItemDTO;
  disabled: boolean;
  onChange: (side: { touchesFrontend: boolean; touchesBackend: boolean }) => void;
}) {
  const untagged = !li.touchesFrontend && !li.touchesBackend;

  return (
    <span
      className="flex shrink-0 items-center gap-px"
      // Untagged isn't an error — most rows predate tagging — but it is the
      // state that costs precision when this estimate feeds the preset library.
      title={
        untagged
          ? 'Not tagged — set whether this touches frontend, backend or both'
          : 'Which side of the stack this touches. Does not split the hours.'
      }
      data-testid={`side-tag-${li.id}`}
    >
      <SideToggle
        label="BE"
        on={li.touchesBackend}
        disabled={disabled}
        testid={`side-be-${li.id}`}
        onClick={() => onChange({ touchesFrontend: li.touchesFrontend, touchesBackend: !li.touchesBackend })}
      />
      <SideToggle
        label="FE"
        on={li.touchesFrontend}
        disabled={disabled}
        testid={`side-fe-${li.id}`}
        onClick={() => onChange({ touchesFrontend: !li.touchesFrontend, touchesBackend: li.touchesBackend })}
      />
    </span>
  );
}

function SideToggle({
  label,
  on,
  disabled,
  testid,
  onClick,
}: {
  label: string;
  on: boolean;
  disabled: boolean;
  testid: string;
  onClick: () => void;
}) {
  // Green when on, hairline ghost when off — the same on/off vocabulary the
  // rest of the ledger uses, at the smallest size that stays legible.
  const base =
    'num w-[22px] rounded-[3px] border px-0.5 text-center text-[9.5px] font-bold tracking-[0.02em] transition-colors';
  const tone = on
    ? 'border-green-line bg-green-tint text-green'
    : 'border-line-soft bg-transparent text-ink-4';

  if (disabled) {
    return (
      <span className={`${base} ${tone}`} data-testid={testid} data-on={on}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-label={`${label} — ${on ? 'on' : 'off'}`}
      className={`${base} ${tone} hover:border-green-line hover:text-green`}
      data-testid={testid}
      data-on={on}
    >
      {label}
    </button>
  );
}
