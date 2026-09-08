'use client';

import { useCallback, useState } from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { ArtifactFrame } from './ArtifactFrame';

/**
 * Read the document before it is finished. AEH-326.
 *
 * ## Why it sits beside the checklist rather than replacing it
 *
 * They answer different questions. The checklist answers "how far along", which
 * is worth knowing continuously and costs nothing to show. This answers "is it
 * any good", which is asked once, is expensive to answer, and has a decision
 * attached — the Stop button directly above.
 *
 * ## Why it does not ride the two-second poll
 *
 * A section is 8 to 12 kilobytes, so re-assembling ten of them every two
 * seconds would put ~100KB on the wire repeatedly to redraw prose nobody is
 * re-reading. It is fetched when asked for, and the poll's count is used to
 * offer a refresh once there is actually more to read. The reader is not going
 * anywhere.
 */

type Fetched = { html: string; written: number; planned: number };

export function ArtifactPartialPreview({
  estimateId,
  artifactId,
  writtenCount,
}: {
  estimateId: string;
  artifactId: string;
  /**
   * Sections landed according to the live poll. Compared against what the shown
   * preview actually contains, which is what makes "3 more since" honest rather
   * than a guess.
   */
  writtenCount: number;
}) {
  const [shown, setShown] = useState<Fetched | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/estimates/${estimateId}/artifacts/${artifactId}/partial`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        setError('Could not assemble what has been written so far.');
        return;
      }
      const body = (await res.json()) as { html: string | null; written: number; planned: number };
      if (!body.html) {
        // Raced the first section: offered on a poll that had counted one, and
        // by the click it was gone? It cannot be — sections are never deleted —
        // so this is the zero case, and saying so beats an empty frame.
        setError('Nothing has been written yet. The first section is still being generated.');
        return;
      }
      setShown({ html: body.html, written: body.written, planned: body.planned });
    } catch {
      setError('Could not reach the server. It may still be generating.');
    } finally {
      setLoading(false);
    }
  }, [estimateId, artifactId]);

  // Sections that have landed since the shown preview was assembled. The whole
  // reason a refresh is offered rather than run: without a number, a Refresh
  // button is a question the reader cannot answer.
  const behind = shown ? Math.max(0, writtenCount - shown.written) : 0;

  if (!shown) {
    return (
      <Card className="mt-3 max-w-[720px]" data-testid="artifact-partial">
        <CardBody>
          <Eyebrow>Read it as it lands</Eyebrow>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">
            {writtenCount === 1
              ? 'One section is written and saved.'
              : `${writtenCount} sections are written and saved.`}{' '}
            Reading the first one is how you tell whether the rest is worth waiting for — and if it
            has gone wrong, Stop is right above, before the rest are paid for.
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
              data-testid="read-partial"
            >
              <BookOpen size={13} strokeWidth={2} />
              {loading ? 'Assembling' : 'Read what is written'}
            </Button>
          </div>
          {error && (
            <p className="mt-2.5 text-[11.5px] text-brick" data-testid="partial-error">
              {error}
            </p>
          )}
        </CardBody>
      </Card>
    );
  }

  return (
    <section className="mt-4" data-testid="artifact-partial">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Labelled, not just tinted: this frame is a page's scroll away from
              the finished document's, and the two must never be confused. */}
          <Pill tone="bronze" data-testid="partial-badge">
            draft
          </Pill>
          <span className="text-[12.5px] text-ink-3" data-testid="partial-count">
            showing <span className="num">{shown.written}</span>
            {shown.planned > 0 ? (
              <>
                {' '}
                of <span className="num">{shown.planned}</span>
              </>
            ) : null}{' '}
            {shown.written === 1 && shown.planned <= 1 ? 'section' : 'sections'} · still being
            written
          </span>
        </div>
        <div className="flex items-center gap-2">
          {behind > 0 && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void load()}
              disabled={loading}
              data-testid="refresh-partial"
            >
              <RefreshCw size={11} strokeWidth={2.5} />
              {loading
                ? 'Assembling'
                : `${behind} more written — refresh`}
            </Button>
          )}
          <Button
            type="button"
            variant="quiet"
            size="xs"
            onClick={() => setShown(null)}
            data-testid="hide-partial"
          >
            Hide
          </Button>
        </div>
      </div>

      {error && (
        <p className="mb-2.5 text-[11.5px] text-brick" data-testid="partial-error">
          {error}
        </p>
      )}

      {/* No filename and no Download: see the note on ArtifactFrame's `partial`
          — a half-written file saved to a desktop is the one mistake here that
          survives the generation finishing. */}
      <ArtifactFrame html={shown.html} partial />
    </section>
  );
}
