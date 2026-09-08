'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/** A standard form field. */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink',
        'placeholder:text-ink-4 focus:border-green focus:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink',
      'placeholder:text-ink-4 focus:border-green focus:outline-none',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink',
      'focus:border-green focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Select.displayName = 'Select';

/** A form field label. */
export function FieldLabel({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('mb-1.5 block text-[12.5px] font-semibold text-ink-2', className)}
      {...props}
    />
  );
}

/** Newlines can only reach a ledger title by paste, and are never wanted. */
const NEWLINES = /[\r\n]+/g;

/**
 * Inline-editable text that reads as text until you touch it. Used for every
 * title in the ledger — the estimate reads like a document, and editing is a
 * detail you discover, not chrome you look at.
 *
 * A `<textarea>` rather than an `<input>`, because ledger titles are routinely
 * longer than the column they sit in. In an input that overflow is only
 * reachable by tracking sideways with the arrow keys, and a card whose name you
 * cannot read is a card you cannot check. Here the text wraps and the field
 * grows to hold it.
 *
 * `field-sizing: content` does the growing, in CSS, which is why there is no
 * measurement code, no resize observer, and no height that can go stale — not
 * when a collapsed section reopens, not when the container narrows, and not
 * when the value is assigned imperatively, which is exactly what the
 * Escape-to-revert handlers do. A browser without it falls back to `rows` worth
 * of scrollable text: the behaviour this replaces, never worse than it.
 *
 * The value is still one line. `Enter` belongs to the caller — every ledger
 * title commits and blurs on it — and newlines are flattened on the way out,
 * because an input dropped pasted ones silently and a line break smuggled into
 * a title would travel as far as the sheet export.
 *
 * Flattened on blur rather than as you type, and that is not laziness: doing it
 * on input means writing `value` back mid-edit, and React restores the caret it
 * recorded before the handler ran, so a pasted CRLF left the cursor a character
 * adrift for every line break in it. Blur is the moment the text becomes data,
 * the caret no longer matters, and the caller's own `onBlur` — which is what
 * persists the value — reads the flattened text because this runs first.
 */
export const InlineText = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, rows = 1, onBlur, ...props }, ref) => (
  <textarea
    ref={ref}
    rows={rows}
    onBlur={(e) => {
      const el = e.currentTarget;
      const flat = el.value.replace(NEWLINES, ' ');
      if (flat !== el.value) el.value = flat;
      onBlur?.(e);
    }}
    className={cn(
      'field-sizing-content w-full min-w-0 resize-none rounded border border-transparent bg-transparent px-1.5 py-0.5',
      'hover:border-line hover:bg-surface focus:border-green focus:bg-surface focus:outline-none',
      'placeholder:text-ink-4',
      className,
    )}
    {...props}
  />
));
InlineText.displayName = 'InlineText';
