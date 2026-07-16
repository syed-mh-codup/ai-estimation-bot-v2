import * as React from 'react';
import { cn } from '@/lib/utils';

/** A sheet of the Warm Ledger's paper. */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-[10px] border border-line bg-surface', className)}
      {...props}
    />
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}

/** The small uppercase label that names a block. */
export function Eyebrow({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-3',
        className,
      )}
      {...props}
    />
  );
}

/** A serif heading — the editorial voice of the document. */
export function Heading({
  level = 2,
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & { level?: 1 | 2 | 3 }) {
  const Tag = `h${level}` as 'h1' | 'h2' | 'h3';
  const size =
    level === 1
      ? 'text-[33px] leading-[1.15] tracking-[-0.015em]'
      : level === 2
        ? 'text-[22px]'
        : 'text-[17.5px]';
  return <Tag className={cn('font-serif font-medium text-ink', size, className)} {...props} />;
}
