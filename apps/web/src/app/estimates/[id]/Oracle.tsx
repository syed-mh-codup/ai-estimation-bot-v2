'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  MessageSquarePlus,
  Quote,
  Trash2,
  X,
} from 'lucide-react';
import { Eyebrow } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  createOracleThread,
  deleteOracleThread,
  listOracleThreads,
  loadOracleThread,
} from './oracle-actions';
// The single write Oracle may reach. Its own module, deliberately one function
// wide — see the note there, and oracle-no-write.test.ts. AEH-238.
import { recordSuggestedAssumption } from './statement-actions';
import {
  renderSegments,
  THREAD_NUDGE_TOKENS,
  type CitationView,
  type OracleMessageDTO,
  type OracleThreadDTO,
} from './oracle-dto';
import {
  ORACLE_ASK_EVENT,
  citeInSource,
  expandSection,
  onBus,
  type OracleAskDetail,
} from './oracle-bus';
import { closeDock, openDock, toggleDock, useDock } from './dock';

/**
 * Oracle — the floating surface on the estimate screen. AEH-259.
 *
 * MOUNTS OUTSIDE LedgerProvider, and must stay there. That provider is keyed on
 * the joined section and item ids, so it remounts its whole subtree whenever the
 * row set changes — which `router.refresh()` does the instant a run finishes.
 * A conversation living inside it would be wiped at exactly the moment somebody
 * is asking about the results. Entry points inside the ledger reach this through
 * the window-event bus instead (oracle-bus.ts).
 *
 * The resting state is a TAB on the right edge, always visible.
 *
 * It was a 3px notch that grew on hover, on the argument that this page is
 * dense and a permanent control sits on top of it all day for a feature most
 * sessions never open. That argument was wrong in the way undiscoverable
 * things are always wrong: a control you have to already know about, and then
 * hover a sliver to reveal, is a control most people never find. The reporter
 * asked for it plainly, having used it.
 *
 * A tab rather than a circular FAB, and it shares that shape with the steered
 * edits tab beneath it: both open a right-hand panel, so they read as two
 * edges of the same drawer rather than two unrelated buttons. ⌘K still opens
 * it from anywhere.
 */


export function Oracle({
  estimateId,
  initialThreads,
}: {
  estimateId: string;
  initialThreads: OracleThreadDTO[];
}) {
  // Open and close are the dock's, not Oracle's. It is one panel among five
  // now, and the ⌘K that opens it, the notch that rests in its place and the
  // quotation that closes it to reveal itself all have to agree with the four
  // tabs beside it. AEH-377.
  const { open: dockOpen, tab } = useDock();
  const open = dockOpen && tab === 'oracle';
  const setOpen = (next: boolean) => (next ? openDock('oracle') : closeDock());
  const [threads, setThreads] = useState(initialThreads);
  const [activeId, setActiveId] = useState<string | null>(initialThreads[0]?.id ?? null);
  const [messages, setMessages] = useState<OracleMessageDTO[]>([]);
  const [approxContextTokens, setApproxContextTokens] = useState(0);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Resolved after mount, never during render. Deriving it from navigator at
  // module scope makes the server emit "Ctrl K" and a Mac client "⌘K", and React
  // raises a BLOCKING error overlay for a hydration mismatch in dev that
  // swallows clicks — the same failure shape as the dnd-kit id mismatch this
  // suite hit before, which presented as an unrelated timeout.
  const [shortcut, setShortcut] = useState('Ctrl K');
  useEffect(() => {
    if (/Mac|iPhone|iPad/i.test(navigator.userAgent)) setShortcut('⌘K');
  }, []);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<string | null>(null);

  // ── Opening ────────────────────────────────────────────────────────────────

  // ⌘K toggles the dock onto this tab — from closed, from another tab, and
  // back shut. Escape is the dock's, handled once there for all five panels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggleDock('oracle');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reveal the full control when the pointer approaches the corner. Hover alone
  // would be inaccessible, so the notch is also a real focusable button and the
  // shortcut above reaches it without a pointer at all.
  // The proximity listener that used to grow the notch on approach is gone
  // with it. Worth noting what it cost: a `pointermove` handler on `window`
  // running a comparison on every mouse move across the page, to reveal a
  // control that is now simply visible.

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, activeId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming]);

  // ── Loading ────────────────────────────────────────────────────────────────

  const openThread = useCallback(async (threadId: string) => {
    setActiveId(threadId);
    setError(null);
    try {
      const loaded = await loadOracleThread(threadId);
      setMessages(loaded.messages);
      setApproxContextTokens(loaded.approxContextTokens);
    } catch {
      setError('That conversation could not be loaded.');
    }
  }, []);

  // Gated on which thread has been loaded, NOT on messages.length: a thread
  // with no messages yet — exactly what the "New thread" button creates —
  // would otherwise re-fetch forever, since loading it leaves the list empty
  // and re-satisfies the condition.
  const loadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !activeId || loadedRef.current === activeId) return;
    loadedRef.current = activeId;
    void openThread(activeId);
  }, [open, activeId, openThread]);

  // ── Asking ─────────────────────────────────────────────────────────────────

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || busy) return;

      setBusy(true);
      setError(null);
      setDraft('');

      try {
        let threadId = activeId;
        if (!threadId) {
          const created = await createOracleThread(estimateId, text);
          threadId = created.id;
          setThreads((prev) => [created, ...prev]);
          setActiveId(created.id);
          // Mark it loaded before the id lands in state, or the loader effect
          // fires mid-stream and overwrites the question we just optimistically
          // rendered with an empty server copy.
          loadedRef.current = created.id;
        }

        // Show the question immediately. The server writes it before requesting
        // a single token, so this is not optimism about whether it landed.
        setMessages((prev) => [
          ...prev,
          {
            id: `pending-${Date.now()}`,
            role: 'USER',
            content: text,
            createdAt: new Date().toISOString(),
            citations: [],
            stale: false,
            modelString: null,
            promptTokens: null,
            completionTokens: null,
            costUsd: null,
          },
        ]);
        setStreaming('');

        const res = await fetch(`/api/estimates/${estimateId}/oracle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId, question: text }),
        });
        if (!res.ok || !res.body) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? 'Oracle is unavailable right now.');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let failed: string | null = null;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const line = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const payload = JSON.parse(line.slice(5).trim()) as
              | { type: 'delta'; text: string }
              | { type: 'done'; messageId: string }
              | { type: 'error'; message: string };

            if (payload.type === 'delta') setStreaming((prev) => (prev ?? '') + payload.text);
            if (payload.type === 'error') failed = payload.message;
          }
        }

        setStreaming(null);
        if (failed) setError(failed);
        // Reload rather than keep the streamed text: what renders is then what
        // was persisted, with its quotations checked server-side against the
        // current corpus. Anything else risks the panel showing an answer more
        // trustworthy than the stored one.
        await openThread(threadId);
        setThreads(await listOracleThreads(estimateId));
      } catch (err) {
        setStreaming(null);
        setError(err instanceof Error ? err.message : 'Oracle could not answer.');
      } finally {
        setBusy(false);
      }
    },
    [activeId, busy, estimateId, openThread],
  );

  // Entry points elsewhere on the page (a card, a narrative line, a selection).
  useEffect(() => {
    return onBus<OracleAskDetail>(ORACLE_ASK_EVENT, ({ question, send }) => {
      setOpen(true);
      if (send) {
        pendingRef.current = question;
      } else {
        setDraft(question);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    });
  }, []);

  useEffect(() => {
    const queued = pendingRef.current;
    if (open && queued && !busy) {
      pendingRef.current = null;
      void ask(queued);
    }
  }, [open, busy, ask]);

  // ── Quote jump ─────────────────────────────────────────────────────────────

  /**
   * Get out of the way, then highlight.
   *
   * The ticket flags this tension and it is real: an expanded panel covers the
   * page, including the source block the jump is meant to reveal. Highlighting a
   * span behind the panel would be worse than not jumping at all, so the panel
   * closes back to the notch. The conversation is not lost — reopening restores
   * it — and the reader gets what they asked for, which is to see the words in
   * the document.
   */
  function jumpToQuote(quote: string) {
    setOpen(false);
    expandSection('sow');
    requestAnimationFrame(() => citeInSource({ quote }));
  }

  // ── Threads ────────────────────────────────────────────────────────────────

  async function newThread() {
    const created = await createOracleThread(estimateId);
    setThreads((prev) => [created, ...prev]);
    setActiveId(created.id);
    loadedRef.current = created.id;
    setMessages([]);
    setApproxContextTokens(0);
    inputRef.current?.focus();
  }

  async function removeThread(threadId: string) {
    await deleteOracleThread(threadId);
    const remaining = threads.filter((t) => t.id !== threadId);
    setThreads(remaining);
    if (activeId === threadId) {
      setActiveId(remaining[0]?.id ?? null);
      setMessages([]);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  // The resting state belongs to the dock now: its notch rail carries this
  // panel's, so there is one stack of tabs on the edge rather than two
  // floating buttons that had to be told about each other's heights.
  if (!open) return null;

  const active = threads.find((t) => t.id === activeId) ?? null;
  const tooLong = approxContextTokens > THREAD_NUDGE_TOKENS;

  return (
    // Not positioned, not sized, no shadow: the dock owns all three. What used
    // to be a 440 by 640 box floating over the ledger is now a full-height
    // column of the page, which is the whole of the difference between a panel
    // you consult and one you dismiss. AEH-377.
    <div data-testid="oracle-panel" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b border-line-soft px-3.5 py-2.5">
        <div className="flex-1 truncate font-serif text-[15px] text-ink">
          {active?.title ?? 'Ask Oracle'}
          {/* The shortcut stays visible: it is how a returning user stops
              reaching for the mouse, and an aria description cannot teach it. */}
          <span className="num ml-2 text-[11px] text-ink-4">{shortcut}</span>
        </div>
        <button
          type="button"
          onClick={newThread}
          title="New thread"
          aria-label="New thread"
          data-testid="oracle-new-thread"
          className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close Oracle"
          data-testid="oracle-close"
          className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      {threads.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-line-soft px-2.5 py-1.5">
          {threads.map((t) => (
            <div key={t.id} className="group flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => {
                  setMessages([]);
                  loadedRef.current = t.id;
                  void openThread(t.id);
                }}
                className={cn(
                  'max-w-[150px] truncate rounded-full px-2.5 py-1 text-[11.5px]',
                  t.id === activeId
                    ? 'bg-green-tint text-green-deep'
                    : 'text-ink-3 hover:bg-surface-2 hover:text-ink',
                )}
              >
                {t.title}
              </button>
              <button
                type="button"
                onClick={() => void removeThread(t.id)}
                aria-label={`Delete thread ${t.title}`}
                className="ml-0.5 hidden rounded p-0.5 text-ink-4 group-hover:block hover:text-brick"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        {messages.length === 0 && !streaming && <EmptyState />}

        {messages.map((m) => (
          <Turn key={m.id} message={m} onJump={jumpToQuote} estimateId={estimateId} />
        ))}

        {streaming !== null && (
          <div className="rounded-[8px] border border-line-soft bg-surface-2 p-3 text-[13px] leading-relaxed text-ink-2">
            {streaming || (
              <span className="flex items-center gap-2 text-ink-3">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Reading the estimate…
              </span>
            )}
          </div>
        )}

        {error && (
          <div
            className="flex items-start gap-2 rounded-[8px] border border-brick-line bg-brick-tint p-3 text-[12.5px] text-ink"
            data-testid="oracle-error"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brick" aria-hidden />
            <span>{error}</span>
          </div>
        )}

        {tooLong && (
          <p className="text-[11.5px] text-ink-3" data-testid="oracle-length-nudge">
            This conversation is getting long, so every answer now carries a lot of history and
            will be slower. Starting a new thread for a separate question keeps it sharp.
          </p>
        )}
      </div>

      <div className="border-t border-line px-3.5 py-2.5">
        <textarea
          ref={inputRef}
          rows={2}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask(draft);
            }
          }}
          placeholder="Ask about the source material, a card, or a number…"
          data-testid="oracle-input"
          className="w-full resize-none rounded-md border border-line bg-surface-2 px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:border-green focus:outline-none disabled:opacity-60"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <p className="text-[10.5px] leading-tight text-ink-4">
            Conversations are saved and can be read by an admin.
          </p>
          <button
            type="button"
            onClick={() => void ask(draft)}
            disabled={busy || !draft.trim()}
            data-testid="oracle-send"
            className="rounded-md bg-green px-3 py-1.5 text-[12.5px] font-medium text-surface disabled:opacity-40"
          >
            {busy ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="px-1 py-6 text-[12.5px] leading-relaxed text-ink-3">
      <Eyebrow>Oracle</Eyebrow>
      <p className="mt-2">
        Ask about this estimate&apos;s source material and anything derived from it — what the
        client asked for, where a card came from, what drove a number.
      </p>
      <p className="mt-2">
        Answers quote the document and link back to it. When the documents don&apos;t cover
        something, Oracle says so rather than guessing. It can&apos;t change a number on the
        estimate — the one thing it can do is add an assumption it suggests, when you click to
        record it.
      </p>
    </div>
  );
}

function Turn({
  message,
  onJump,
  estimateId,
}: {
  message: OracleMessageDTO;
  onJump: (quote: string) => void;
  /** Needed only by the one write Oracle may reach — see statement-actions.ts. */
  estimateId: string;
}) {
  if (message.role === 'USER') {
    return (
      <div className="ml-6 rounded-[8px] bg-green-tint px-3 py-2 text-[13px] whitespace-pre-wrap text-green-deep">
        {message.content}
      </div>
    );
  }

  return (
    <div className="space-y-1.5" data-testid="oracle-answer">
      <div className="rounded-[8px] border border-line-soft bg-surface-2 p-3 text-[13px] leading-relaxed text-ink-2">
        {renderSegments(message.content).map((seg, i) => {
          if (seg.type === 'text') {
            return (
              <span key={i} className="whitespace-pre-wrap">
                {seg.value}
              </span>
            );
          }
          if (seg.type === 'assumption') {
            return (
              <SuggestedAssumption key={i} wording={seg.value.trim()} estimateId={estimateId} />
            );
          }
          return (
            <QuoteChip
              key={i}
              quote={seg.value}
              citation={message.citations.find((c) => c.quote === seg.value.trim())}
              onJump={onJump}
            />
          );
        })}
      </div>

      {message.stale && (
        <p className="flex items-center gap-1.5 text-[11px] text-bronze-ink" data-testid="oracle-stale">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          The estimate has changed since this answer was written.
        </p>
      )}

    </div>
  );
}

/**
 * A quotation, and whether it survived checking.
 *
 * Three states, and the difference between the last two is the point of the
 * whole verification pass: an unverified quotation against an UNCHANGED source
 * was invented, and the reader has to be told plainly. The same quotation
 * against a source that has since been edited is ordinary drift.
 */
function QuoteChip({
  quote,
  citation,
  onJump,
}: {
  quote: string;
  citation: CitationView | undefined;
  onJump: (q: string) => void;
}) {
  const status = citation?.status ?? 'verified';
  const jumpable = !!citation?.location;

  if (status === 'fabricated') {
    return (
      <span
        data-testid="oracle-quote-fabricated"
        title="This wording does not appear anywhere in the estimate, and the source has not changed since the answer was written."
        className="mx-0.5 rounded-[3px] border border-brick-line bg-brick-tint px-1 py-0.5 text-[12.5px] text-ink line-through decoration-brick/60"
      >
        {quote}
      </span>
    );
  }

  if (status === 'source-moved') {
    return (
      <span
        data-testid="oracle-quote-moved"
        title="The source material has been edited since this answer, and this wording is no longer in it."
        className="mx-0.5 rounded-[3px] border border-bronze-line bg-bronze-tint px-1 py-0.5 text-[12.5px] text-ink"
      >
        {quote}
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={!jumpable}
      onClick={() => onJump(quote)}
      data-testid="oracle-quote"
      title={jumpable ? 'Show this in the source material' : 'Verified, but not in the source block'}
      className={cn(
        'mx-0.5 inline items-baseline gap-1 rounded-[3px] border border-green-line bg-green-tint px-1 py-0.5 text-left text-[12.5px] text-green-deep',
        jumpable && 'hover:border-green hover:bg-green hover:text-surface',
      )}
    >
      <Quote className="mr-1 mb-0.5 inline h-2.5 w-2.5" aria-hidden />
      {quote}
    </button>
  );
}

/**
 * Wording Oracle suggests recording, with two ways to accept it.
 *
 * Until AEH-238 copy was all this did, and the comment here said why: Oracle
 * may recommend an assumption, it may not write one. That has changed
 * deliberately, and what changed is narrower than it looks. Oracle still cannot
 * move a number — no hours, no cards, no totals — and the guarantee AEH-259
 * asserted with a test now asserts exactly that instead of an absolute. The
 * write is one sentence appended to a list, by a person clicking a button.
 *
 * Copy stays, because pasting it somewhere else is a real use.
 *
 * Either way it takes exactly the proposed sentence, which is why the model
 * marks that sentence up rather than the UI guessing at it. The first version
 * copied the whole answer and left the estimator to trim the explanation off —
 * fine for a demo, wrong for something you paste into a client document.
 */
function SuggestedAssumption({ wording, estimateId }: { wording: string; estimateId: string }) {
  const [copied, setCopied] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <span
      data-testid="oracle-assumption"
      className="my-1.5 flex items-start gap-2 rounded-[6px] border border-line bg-surface px-2.5 py-2"
    >
      <span className="min-w-0 flex-1">
        <span className="eyebrow block text-ink-4">Suggested assumption</span>
        <span
          className="mt-0.5 block text-[12.5px] leading-relaxed text-ink"
          data-testid="oracle-assumption-text"
        >
          {wording}
        </span>
      </span>
      <button
        type="button"
        title="Copy this wording"
        aria-label="Copy this assumption wording"
        data-testid="oracle-copy-assumption"
        onClick={() => {
          void navigator.clipboard.writeText(wording);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        }}
        className="shrink-0 rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-green"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>
      <button
        type="button"
        disabled={recorded}
        title="Add this to the estimate's assumptions"
        aria-label="Record this assumption on the estimate"
        data-testid="oracle-record-assumption"
        onClick={() => {
          setFailed(null);
          void (async () => {
            const res = await recordSuggestedAssumption(estimateId, wording);
            if (res.ok) setRecorded(true);
            else setFailed(res.reason ?? 'Could not record it');
          })();
        }}
        className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] font-semibold text-ink-3 hover:border-green hover:text-green disabled:border-green disabled:text-green"
      >
        {recorded ? 'Recorded' : 'Record it'}
      </button>
      {failed && (
        <span className="w-full text-[11px] text-brick" data-testid="oracle-record-error">
          {failed}
        </span>
      )}
    </span>
  );
}
