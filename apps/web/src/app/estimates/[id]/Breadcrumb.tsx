import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

/**
 * Where this estimate sits, above its own title. AEH-377.
 *
 * What it replaces was a single text link reading "← Estimates" or "← Project",
 * which had to choose between naming the destination and naming the level. It
 * did both badly: "Project" says what kind of thing you are going to and not
 * which one, and on a fork "Estimates" pointed at a list that shows the whole
 * family as one row, so it skipped the view holding its siblings.
 *
 * A trail says both at once. The button is the way out and always goes to the
 * same place, which is what makes it a reliable thing to aim at; the segment
 * after it names where you are, and links to the family when there is one.
 *
 * A standalone estimate gets the button alone. There is no project to name,
 * and repeating the title one line above the title is furniture.
 */
export function Breadcrumb({
  projectName,
  projectHref,
}: {
  /** The family's name, or null when this estimate is not in one. */
  projectName: string | null;
  /** Where that name goes — null renders it as plain text. */
  projectHref: string | null;
}) {
  return (
    <nav className="flex items-center gap-2.5" aria-label="Breadcrumb" data-testid="breadcrumb">
      <Link
        href="/dashboard"
        className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] text-ink-2 transition-colors hover:border-ink-4 hover:text-ink focus-visible:ring-1 focus-visible:ring-green focus-visible:outline-none"
        data-testid="back-link"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        All estimates
      </Link>

      {projectName && (
        <>
          <span className="shrink-0 text-[12px] text-ink-4" aria-hidden>
            /
          </span>
          {projectHref ? (
            <Link
              href={projectHref}
              className="min-w-0 truncate text-[12px] text-ink-2 hover:text-ink hover:underline"
              data-testid="breadcrumb-project"
            >
              {projectName}
            </Link>
          ) : (
            <span className="min-w-0 truncate text-[12px] text-ink-2" data-testid="breadcrumb-project">
              {projectName}
            </span>
          )}
        </>
      )}
    </nav>
  );
}
