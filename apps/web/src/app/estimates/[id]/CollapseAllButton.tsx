'use client';

import { useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const COLLAPSE_ALL_EVENT = 'estimate:collapse-all';

/** Broadcasts a collapse/expand-all request that every CollapsibleSection and
 * the Menu Card editor on the page listen for. */
export function CollapseAllButton() {
  const [collapsed, setCollapsed] = useState(false);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    window.dispatchEvent(new CustomEvent(COLLAPSE_ALL_EVENT, { detail: { collapsed: next } }));
  };

  return (
    <Button variant="outline" size="sm" onClick={toggle} data-testid="collapse-all">
      {collapsed ? (
        <ChevronsUpDown className="h-3.5 w-3.5" />
      ) : (
        <ChevronsDownUp className="h-3.5 w-3.5" />
      )}
      {collapsed ? 'Expand all' : 'Collapse all'}
    </Button>
  );
}
