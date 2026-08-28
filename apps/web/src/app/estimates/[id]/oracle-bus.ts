/**
 * A tiny window-event bus between the page and the Oracle panel.
 *
 * This exists because of where Oracle has to mount. `LedgerProvider` is keyed on
 * the joined section and item ids, so it remounts its entire subtree whenever
 * the row set changes — which `router.refresh()` does every time a run
 * finishes. A chat panel inside that subtree would lose an open conversation at
 * exactly the moment someone is asking about the results. So Oracle mounts
 * OUTSIDE the provider, and the entry points inside it (a menu card, a
 * narrative line) cannot reach it by prop or context.
 *
 * Window events are the house idiom for this already — see
 * CollapseAllButton's `estimate:collapse-all`, which the same page uses to
 * reach every CollapsibleSection. Typed here so the two ends cannot disagree
 * about the payload.
 */

/** Ask Oracle to open with a question already in the composer. */
export const ORACLE_ASK_EVENT = 'oracle:ask';
/** Ask the page to reveal and highlight a quoted span. */
export const ORACLE_CITE_EVENT = 'oracle:cite';
/** Ask a CollapsibleSection to open itself. */
export const EXPAND_SECTION_EVENT = 'estimate:expand-section';

export type OracleAskDetail = {
  /** Pre-filled question text. */
  question: string;
  /** Send it immediately, or leave it for the estimator to edit first. */
  send?: boolean;
};

export type OracleCiteDetail = {
  /** The verbatim span to find and highlight. */
  quote: string;
};

export function askOracle(detail: OracleAskDetail): void {
  window.dispatchEvent(new CustomEvent(ORACLE_ASK_EVENT, { detail }));
}

export function citeInSource(detail: OracleCiteDetail): void {
  window.dispatchEvent(new CustomEvent(ORACLE_CITE_EVENT, { detail }));
}

export function expandSection(id: string): void {
  window.dispatchEvent(new CustomEvent(EXPAND_SECTION_EVENT, { detail: { id } }));
}

/** Subscribe to a bus event, returning an unsubscribe. */
export function onBus<T>(name: string, handler: (detail: T) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<T>).detail);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}
