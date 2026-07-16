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

/**
 * Inline-editable text that reads as text until you touch it. Used for every
 * title in the ledger — the estimate reads like a document, and editing is a
 * detail you discover, not chrome you look at.
 */
export const InlineText = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    type="text"
    className={cn(
      'w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-0.5',
      'hover:border-line hover:bg-surface focus:border-green focus:bg-surface focus:outline-none',
      'placeholder:text-ink-4',
      className,
    )}
    {...props}
  />
));
InlineText.displayName = 'InlineText';
