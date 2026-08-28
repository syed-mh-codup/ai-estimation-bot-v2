'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  MessageSquarePlus,
  Quote,
  Sparkles,
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
 * The resting state is a small notch in the corner rather than a full button.
 * This page is deliberately dense — it is meant to read as a document — and a
 * permanent floating action button sits on top of that all day for a feature
 * most sessions never open. The notch grows into the real control on approach
 * or on focus, and ⌘K opens it from anywhere.
 */

const SHORTCUT_HINT = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
  ? '⌘K'
  : 'Ctrl K';

export function Oracle({
  estimateId,
  initialThreads,
}: {
  estimateId: string;
  initialThreads: OracleThreadDTO[];
}) {
  const [open, setOpen] = useState(false);
  const [near, setNear] = useState(false);
  const [threads, setThreads] = useState(initialThreads);
  const [activeId, setActiveId] = useState<string | null>(initialThreads[0]?.id ?? null);
  const [messages, setMessages] = useState<OracleMessageDTO[]>([]);
  const [approxTokens, setApproxTokens] = useState(0);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<string | null>(null);

  // ── Opening ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reveal the full control when the pointer approaches the corner. Hover alone
  // would be inaccessible, so the notch is also a real focusable button and the
  // shortcut above reaches it without a pointer at all.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const dx = window.innerWidth - e.clientX;
      const dy = window.innerHeight - e.clientY;
      setNear(dx < 220 && dy < 220);
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

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
      setApproxTokens(loaded.approxTokens);
    } catch {
      setError('That conversation could not be loaded.');
    }
  }, []);

  useEffect(() => {
    if (open && activeId && messages.length === 0) void openThread(activeId);
    // Only on opening or switching threads; openThread is stable.
  }, [open, activeId, messages.length, openThread]);

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
    setMessages([]);
    setApproxTokens(0);
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

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="oracle-notch"
        aria-label={`Ask Oracle about this estimate (${SHORTCUT_HINT})`}
        className={cn(
          'group fixed right-0 bottom-16 z-40 flex items-center gap-2 rounded-l-full border border-r-0 border-line bg-surface text-ink shadow-[0_6px_24px_rgba(35,33,27,0.12)] transition-all duration-200',
          'focus-visible:ring-2 focus-visible:ring-green focus-visible:outline-none',
          near
            ? 'h-10 pr-4 pl-3.5'
            : 'h-9 w-3 justify-center px-0 hover:w-auto hover:pr-4 hover:pl-3.5',
        )}
      >
        <Sparkles
          className={cn('h-4 w-4 shrink-0 text-green', !near && 'hidden group-hover:block')}
          aria-hidden
        />
        <span
          className={cn(
            'text-[13px] font-medium whitespace-nowrap',
            !near && 'hidden group-hover:inline',
          )}
        >
          Ask Oracle
          <span className="num ml-2 text-[11px] text-ink-4">{SHORTCUT_HINT}</span>
        </span>
      </button>
    );
  }

  const active = threads.find((t) => t.id === activeId) ?? null;
  const tooLong = approxTokens > THREAD_NUDGE_TOKENS;

  return (
    <div
      data-testid="oracle-panel"
      className="fixed right-4 bottom-4 z-40 flex h-[min(640px,calc(100vh-2rem))] w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[10px] border border-line bg-surface shadow-[0_16px_48px_rgba(35,33,27,0.18)]"
    >
      <header className="flex items-center gap-2 border-b border-line bg-surface-2 px-3.5 py-2.5">
        <Sparkles className="h-4 w-4 text-green" aria-hidden />
        <div className="flex-1 truncate font-serif text-[15px] text-ink">
          {active?.title ?? 'Ask Oracle'}
        </div>
        <button
          type="button"
          onClick={newThread}
          title="New thread"
          aria-label="New thread"
          data-testid="oracle-new-thread"
          className="rounded p-1 text-ink-3 hover:bg-surface hover:text-ink"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close Oracle"
          data-testid="oracle-close"
          className="rounded p-1 text-ink-3 hover:bg-surface hover:text-ink"
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
          <Turn key={m.id} message={m} onJump={jumpToQuote} />
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
        something, Oracle says so rather than guessing. It can&apos;t change the estimate.
      </p>
    </div>
  );
}

function Turn({
  message,
  onJump,
}: {
  message: OracleMessageDTO;
  onJump: (quote: string) => void;
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
        {renderSegments(message.content).map((seg, i) =>
          seg.type === 'text' ? (
            <span key={i} className="whitespace-pre-wrap">
              {seg.value}
            </span>
          ) : (
            <QuoteChip
              key={i}
              quote={seg.value}
              citation={message.citations.find((c) => c.quote === seg.value.trim())}
              onJump={onJump}
            />
          ),
        )}
      </div>

      {message.stale && (
        <p className="flex items-center gap-1.5 text-[11px] text-bronze-ink" data-testid="oracle-stale">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          The estimate has changed since this answer was written.
        </p>
      )}

      <CopyAsAssumption content={message.content} />
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
 * Copy, and nothing else.
 *
 * Oracle may recommend recording something as an assumption; it may not write
 * one. No prefill of the assumptions editor, no unsaved row, no server action —
 * the estimator decides what goes on the estimate, every time.
 */
function CopyAsAssumption({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  if (!/assumption/i.test(content)) return null;

  return (
    <button
      type="button"
      data-testid="oracle-copy-assumption"
      onClick={() => {
        void navigator.clipboard.writeText(content.replace(/\[\[|\]\]/g, ''));
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      }}
      className="flex items-center gap-1.5 text-[11px] text-ink-3 hover:text-green"
    >
      {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
      {copied ? 'Copied — paste it into Assumptions' : 'Copy for the assumptions list'}
    </button>
  );
}
