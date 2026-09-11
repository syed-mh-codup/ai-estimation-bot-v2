'use client';

import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A click-to-open panel anchored to the thing that opened it. AEH-377.
 *
 * Over Radix rather than hand-rolled, unlike `Combobox` next door — that one
 * had no Radix primitive to sit on, and this one has exactly the right
 * primitive already in `package.json`. What it buys is the part that is tedious
 * and easy to get subtly wrong: focus moves into the panel and back out to the
 * trigger, Escape closes, an outside click closes, arrow keys walk the items,
 * and the panel flips or shifts rather than hanging off the viewport. The
 * ledger's rows run to the right edge of a wide screen, so that last one is not
 * a nicety.
 *
 * It replaces two different things on the estimate screen, which is why it is a
 * primitive and not one component: the marks, which explain themselves where
 * you meet them, and the per-row actions, which used to appear only on hover.
 */
export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;

export function MenuContent({
  children,
  className,
  align = 'start',
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        sideOffset={6}
        collisionPadding={12}
        className={cn(
          'z-50 min-w-[180px] rounded-[10px] border border-line bg-surface p-1.5',
          'shadow-[0_16px_44px_rgba(35,33,27,0.16)] focus:outline-none',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      >
        {children}
      </MenuPrimitive.Content>
    </MenuPrimitive.Portal>
  );
}

/**
 * One action. `tone="danger"` is brick, per the palette's third job.
 *
 * `onSelect` rather than `onClick`, because Radix closes the panel for you on
 * select and a click handler alone leaves it open behind whatever it did.
 */
export function MenuItem({
  className,
  tone = 'default',
  // `children` deliberately stays in `...props` rather than being pulled out:
  // destructuring it here and then forwarding only the rest renders an item
  // with nothing in it, which typechecks and lints clean.
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & { tone?: 'default' | 'danger' }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[12.5px] outline-none',
        'data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-4',
        tone === 'danger'
          ? 'text-brick data-[highlighted]:bg-brick-tint'
          : 'text-ink-2 data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink',
        className,
      )}
      {...props}
    />
  );
}

export function MenuSeparator({ className }: { className?: string }) {
  return <MenuPrimitive.Separator className={cn('my-1 h-px bg-line-soft', className)} />;
}

/**
 * Prose inside the panel — what a mark means, before the things you can do
 * about it.
 *
 * A `Label` rather than an `Item` on purpose: it is not selectable, so the
 * arrow keys skip it and a screen reader does not offer it as an action.
 */
export function MenuNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <MenuPrimitive.Label className={cn('px-2.5 py-1.5 font-normal', className)}>
      {children}
    </MenuPrimitive.Label>
  );
}
