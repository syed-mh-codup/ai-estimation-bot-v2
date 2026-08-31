/**
 * Deadline arithmetic. Pure, and kept apart from the sweep that acts on it
 * (lib/reminders.ts) for two reasons: which nudge is owed is the only part of
 * this feature with an off-by-one-day in it, so it is the part worth testing
 * without a database; and the rail and the dashboard need the same phrasing in
 * the browser, where nothing that touches Prisma or SMTP belongs.
 *
 * `Estimate.dueAt` is stored as midnight UTC of the chosen date (see the schema
 * comment), so everything here counts WHOLE UTC DAYS. No timezone maths, no
 * "is it 23:00 tomorrow", no drift when the cron fires an hour late.
 */
import type { ReminderKind } from '@repo/db';

const MS_PER_DAY = 86_400_000;

/** Midnight UTC of whatever day this instant falls on. */
function utcDayStart(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Whole days from `now` until `dueAt`. Negative once the date has passed, 0 on
 * the day itself.
 */
export function daysUntilDue(dueAt: Date, now: Date): number {
  return Math.round((utcDayStart(dueAt) - utcDayStart(now)) / MS_PER_DAY);
}

/** How far out a reminder starts caring. Three days of warning. */
export const HEADS_UP_DAYS = 3;

/**
 * Which reminder this estimate is owed today, or null for "nothing to say".
 *
 * Only the most urgent applicable beat is returned, and each beat is sent at
 * most once — enforced by the EstimateReminder unique key, not by this
 * function. A deadline set for tomorrow therefore gets DUE_TODAY and then
 * OVERDUE but never a retrospective DUE_SOON: telling somebody a thing is due
 * in three days when it is due tomorrow is worse than saying nothing.
 */
export function dueReminder(dueAt: Date, now: Date): ReminderKind | null {
  const days = daysUntilDue(dueAt, now);
  if (days < 0) return 'OVERDUE';
  if (days === 0) return 'DUE_TODAY';
  if (days <= HEADS_UP_DAYS) return 'DUE_SOON';
  return null;
}

/**
 * What a deadline is doing right now, as a semantic state rather than a colour.
 *
 * Deliberately not a tone name: this module knows about dates, not about the
 * palette. The dashboard maps these onto pills; the email maps them onto its
 * own inline styles. Neither mapping belongs here.
 *
 * FINALISED collapses to `settled` whatever the date says — an estimate that is
 * finished cannot be late, and colouring it red would be a standing false alarm
 * on every old estimate that ever had a deadline.
 */
export type DueState = 'overdue' | 'due-today' | 'upcoming' | 'settled' | 'none';

export function dueState(dueAt: Date | null, now: Date, isFinalised: boolean): DueState {
  if (!dueAt) return 'none';
  if (isFinalised) return 'settled';
  const days = daysUntilDue(dueAt, now);
  if (days < 0) return 'overdue';
  if (days === 0) return 'due-today';
  return 'upcoming';
}

/**
 * Dashboard ordering: what still needs doing, soonest first.
 *
 * Two groups, not three. Anything dated and unfinished sorts by `dueAt`
 * ascending, which puts the most overdue at the very top and the soonest next
 * with no special case between them — "most overdue first" and "soonest first"
 * are the same rule. Everything else (undated, or finalised) falls below,
 * newest first, which is the ordering the dashboard used to have throughout.
 *
 * This replaces created-date ordering as the default on purpose: a deadline
 * column that does not reorder the table is a column you have to go looking
 * through, and the whole point of it is not having to.
 */
export function compareByDue(
  a: { dueAt: Date | null; status: string; createdAt: Date },
  b: { dueAt: Date | null; status: string; createdAt: Date },
  now: Date,
): number {
  const pressing = (e: { dueAt: Date | null; status: string }) =>
    e.dueAt !== null && e.status !== 'FINALISED';
  const ap = pressing(a);
  const bp = pressing(b);
  if (ap !== bp) return ap ? -1 : 1;
  if (ap && bp) return daysUntilDue(a.dueAt!, now) - daysUntilDue(b.dueAt!, now);
  return b.createdAt.getTime() - a.createdAt.getTime();
}

/**
 * Human phrasing for a deadline, so the rail, the dashboard and the email
 * subject all say the same thing about the same date.
 */
export function dueLabel(dueAt: Date, now: Date): string {
  const days = daysUntilDue(dueAt, now);
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days > 1) return `due in ${days} days`;
  if (days === -1) return '1 day overdue';
  return `${-days} days overdue`;
}

/**
 * Format a stored deadline as the date that was actually picked.
 *
 * `timeZone: 'UTC'` is load-bearing, not decoration: dueAt is midnight UTC, so
 * local formatting in any negative-offset browser renders the day BEFORE the
 * one somebody chose.
 */
export function formatDueDate(dueAt: Date): string {
  return dueAt.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** The `<input type="date">` value for a stored deadline. */
export function toDateInputValue(dueAt: Date | null): string {
  return dueAt ? dueAt.toISOString().slice(0, 10) : '';
}

/**
 * Read a `YYYY-MM-DD` form value back to the canonical midnight-UTC instant.
 * Returns null for an empty value (no deadline) and throws on anything else —
 * a date field that silently accepted rubbish would store `Invalid Date`.
 */
export function fromDateInputValue(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) throw new Error('Expected a date like 2026-09-12');
  // `new Date('2026-09-12')` is parsed as midnight UTC by spec, and the regex
  // above is what guarantees we only hand it the date-only form that carries
  // that guarantee.
  const parsed = new Date(trimmed);
  // The rollover trap: `new Date('2026-02-31')` does NOT fail, it quietly
  // becomes 3 March. Round-tripping is the only check that catches a date that
  // parsed into a different day than the one written down.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new Error('That is not a real date');
  }
  return parsed;
}
