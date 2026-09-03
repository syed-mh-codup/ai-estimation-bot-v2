import { CORPUS_SECTIONS } from '@repo/db';
import { Eyebrow } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';

/**
 * What the model is allowed to see. AEH-239.
 *
 * Shared by the create form and the editor so the two cannot describe the same
 * choice differently — the thing that decides whether an author's brief can
 * work is what it can actually read, and being told that in one place on one
 * screen and another place on another is how people end up writing prompts
 * against data that was never sent.
 *
 * The blurbs are the point, not the checkboxes. Every artifact type in this
 * system is hand-authored with no seeded example to copy, so this list is the
 * documentation an author reads while writing. It renders from the code-owned
 * catalogue, so it cannot drift from what generation actually assembles.
 *
 * A server component, deliberately: plain checkboxes in the enclosing form need
 * no client JavaScript, and `defaultChecked` is the whole of the state.
 */
export function CorpusPicker({ selected }: { selected: readonly string[] }) {
  const chosen = new Set(selected);

  return (
    <fieldset data-testid="corpus-picker">
      <legend className="sr-only">What this artifact may read</legend>
      <Eyebrow>What it may read</Eyebrow>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
        Only the ticked sections are sent. Tick what the brief actually needs — every section is
        paid for on each generation, and a large one crowds out the model’s attention as well as
        its budget.
      </p>

      <div className="mt-3 space-y-2">
        {CORPUS_SECTIONS.map((section) => (
          <label
            key={section.key}
            htmlFor={`corpus-${section.key}`}
            className="flex cursor-pointer gap-2.5 rounded-md border border-line-soft p-2.5 hover:border-line hover:bg-surface-2"
            data-testid={`corpus-option-${section.key}`}
          >
            <input
              type="checkbox"
              id={`corpus-${section.key}`}
              name="corpusSections"
              value={section.key}
              defaultChecked={chosen.has(section.key)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-green"
            />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] font-semibold text-ink">{section.label}</span>
                {/* Size is shown because an author is choosing what to pay for
                    on every single generation, and "the whole source document"
                    and "four totals" should not look alike. */}
                {section.weight === 'large' && (
                  <Pill tone="bronze" dot={false}>
                    large
                  </Pill>
                )}
                {/* Not a warning — ticking these is normal. It is a heads-up
                    that an artifact generated before the run, the derive or the
                    saved scenario will simply be missing this. */}
                {section.conditional && (
                  <Pill tone="neutral" dot={false}>
                    needs a run
                  </Pill>
                )}
              </span>
              <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-3">
                {section.blurb}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Read the picker's boxes back off a submitted form.
 *
 * `getAll`, not `get`: a checkbox group posts one entry per ticked box, and
 * `get` would silently keep only the first — an artifact type that reads one
 * section when its author chose five, with nothing anywhere saying so.
 *
 * Unknown values are dropped rather than trusted. The keys arrive from a
 * client-submitted form, so this is the boundary where they stop being input.
 */
export function readCorpusSections(formData: FormData): string[] {
  const valid = new Set<string>(CORPUS_SECTIONS.map((s) => s.key));
  return formData
    .getAll('corpusSections')
    .filter((v): v is string => typeof v === 'string')
    .filter((v) => valid.has(v));
}
