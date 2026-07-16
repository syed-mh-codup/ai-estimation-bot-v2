'use client';

import { useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';

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
    <button
      type="button"
      onClick={toggle}
      className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
      data-testid="collapse-all"
    >
      {collapsed ? <ChevronsUpDown className="h-4 w-4" /> : <ChevronsDownUp className="h-4 w-4" />}
      {collapsed ? 'Expand all' : 'Collapse all'}
    </button>
  );
}
