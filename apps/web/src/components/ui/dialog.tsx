'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({
  children,
  className,
  showClose = true,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { showClose?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink/35 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
          'rounded-[10px] border border-line bg-surface p-6 shadow-[0_16px_48px_rgba(35,33,27,0.18)] focus:outline-none',
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            className="absolute right-4 top-4 rounded-md p-1 text-ink-4 hover:bg-surface-2 hover:text-ink-2 focus:outline-none focus-visible:outline-2 focus-visible:outline-green"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Title
      className={cn('font-serif text-[19px] font-medium text-ink', className)}
    >
      {children}
    </DialogPrimitive.Title>
  );
}

export function DialogDescription({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Description className={cn('mt-1.5 text-[13px] leading-relaxed text-ink-3', className)}>
      {children}
    </DialogPrimitive.Description>
  );
}
