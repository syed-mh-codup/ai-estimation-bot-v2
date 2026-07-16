'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Warm Ledger buttons.
 *   default   — green: the one settled, primary action on a screen
 *   outline   — the workhorse secondary
 *   quiet     — a text action that shouldn't compete (e.g. Delete in a rail)
 *   destructive / danger — brick, reserved for removal
 *   dashed    — "add another one of these" affordances inside the ledger
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-green text-surface border border-green hover:bg-green-deep hover:border-green-deep',
        outline: 'border border-line bg-surface text-ink-2 hover:border-ink-4 hover:text-ink',
        secondary:
          'border border-transparent bg-surface-2 text-ink-2 hover:bg-line-soft hover:text-ink',
        ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        quiet: 'text-ink-3 hover:text-ink',
        destructive: 'bg-brick text-surface border border-brick hover:opacity-90',
        danger: 'border border-brick-line text-brick hover:bg-brick-tint hover:border-brick',
        dashed:
          'border border-dashed border-line text-ink-3 hover:border-green-line hover:bg-green-tint hover:text-green',
        link: 'text-green underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 text-[13px]',
        sm: 'h-8 px-3 text-xs',
        xs: 'h-7 px-2.5 text-[11px]',
        lg: 'h-10 px-6 text-sm',
        icon: 'h-8 w-8',
      },
      full: {
        true: 'w-full',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, full, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, full, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
