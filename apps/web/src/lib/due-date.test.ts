import { describe, it, expect } from 'vitest';
import {
  daysUntilDue,
  dueLabel,
  dueReminder,
  formatDueDate,
  fromDateInputValue,
  toDateInputValue,
} from './due-date';

/** A stored deadline: midnight UTC of that date, per the schema convention. */
const due = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
/** 09:00 Pakistan time on that date — when the cron actually fires. */
const sweepAt = (iso: string) => new Date(`${iso}T04:00:00.000Z`);

describe('AEH-240: deadline arithmetic', () => {
  it('counts whole days, not elapsed time', () => {
    // The trap this exists to avoid: a millisecond-based "3 days" call made at
    // 9am on the 9th about a deadline on the 12th is 2.83 days, and rounds the
    // wrong way. Day arithmetic gives the answer a person would give.
    expect(daysUntilDue(due('2026-09-12'), sweepAt('2026-09-09'))).toBe(3);
    expect(daysUntilDue(due('2026-09-12'), sweepAt('2026-09-12'))).toBe(0);
    expect(daysUntilDue(due('2026-09-12'), sweepAt('2026-09-13'))).toBe(-1);
  });

  it('gives the same answer at any hour of the sweep day', () => {
    for (const hour of ['00:01', '04:00', '18:30', '23:59']) {
      expect(daysUntilDue(due('2026-09-12'), new Date(`2026-09-10T${hour}:00.000Z`))).toBe(2);
    }
  });

  it('counts across a month boundary', () => {
    expect(daysUntilDue(due('2026-10-01'), sweepAt('2026-09-28'))).toBe(3);
  });

  describe('dueReminder picks one beat, most urgent first', () => {
    it('says nothing until the heads-up window', () => {
      expect(dueReminder(due('2026-09-12'), sweepAt('2026-09-08'))).toBeNull();
      expect(dueReminder(due('2026-09-12'), sweepAt('2026-09-01'))).toBeNull();
    });

    it('opens the window exactly three days out, and stays open', () => {
      expect(dueReminder(due('2026-09-12'), sweepAt('2026-09-09'))).toBe('DUE_SOON');
      expect(dueReminder(due('2026-09-12'), sweepAt('2026-09-10'))).toBe('DUE_SOON');
      expect(dueReminder(due('2026-09-12'), sweepAt('2026-09-11'))).toBe('DUE_SOON');
    });

    it('the due day itself is DUE_TODAY, not overdue', () => {
      // The bug worth pinning: an "is the deadline in the past" check on raw
      // instants calls 9am on the due date overdue, because midnight has gone.
      expect(dueReminder(due('2026-09-12'), sweepAt('2026-09-12'))).toBe('DUE_TODAY');
    });

    it('is overdue from the next day on', () => {
      expect(dueReminder(due('2026-09-12'), sweepAt('2026-09-13'))).toBe('OVERDUE');
      expect(dueReminder(due('2026-09-12'), sweepAt('2026-11-01'))).toBe('OVERDUE');
    });

    it('never issues a heads-up retrospectively', () => {
      // A deadline set for tomorrow skips DUE_SOON entirely. Saying "due in
      // three days" about something due tomorrow is worse than saying nothing,
      // and time only moves one way, so the skipped beat never fires later.
      const dueAt = due('2026-09-12');
      const kinds = ['2026-09-11', '2026-09-12', '2026-09-13'].map((d) =>
        dueReminder(dueAt, sweepAt(d)),
      );
      expect(kinds).toEqual(['DUE_SOON', 'DUE_TODAY', 'OVERDUE']);
    });
  });

  describe('dueLabel', () => {
    it('reads the way a person would say it', () => {
      const dueAt = due('2026-09-12');
      expect(dueLabel(dueAt, sweepAt('2026-09-05'))).toBe('due in 7 days');
      expect(dueLabel(dueAt, sweepAt('2026-09-11'))).toBe('due tomorrow');
      expect(dueLabel(dueAt, sweepAt('2026-09-12'))).toBe('due today');
      expect(dueLabel(dueAt, sweepAt('2026-09-13'))).toBe('1 day overdue');
      expect(dueLabel(dueAt, sweepAt('2026-09-15'))).toBe('3 days overdue');
    });
  });

  describe('the date round-trip', () => {
    it('survives form value → stored instant → form value', () => {
      const stored = fromDateInputValue('2026-09-12');
      expect(stored?.toISOString()).toBe('2026-09-12T00:00:00.000Z');
      expect(toDateInputValue(stored)).toBe('2026-09-12');
    });

    it('treats empty as no deadline in both directions', () => {
      expect(fromDateInputValue('')).toBeNull();
      expect(fromDateInputValue('   ')).toBeNull();
      expect(toDateInputValue(null)).toBe('');
    });

    it('refuses anything that is not a plain date', () => {
      // Without this, `new Date(junk)` stores an Invalid Date and every
      // downstream comparison silently answers false.
      expect(() => fromDateInputValue('12/09/2026')).toThrow();
      expect(() => fromDateInputValue('2026-09-12T10:00:00Z')).toThrow();
      expect(() => fromDateInputValue('tomorrow')).toThrow();
      // Not pedantry: `new Date('2026-02-31')` parses happily and silently
      // means 3 March, so a typo would store a date nobody chose.
      expect(() => fromDateInputValue('2026-02-31')).toThrow();
      expect(() => fromDateInputValue('2026-13-01')).toThrow();
    });

    it('formats the day that was picked, whatever the machine thinks', () => {
      // `timeZone: 'UTC'` is what makes this hold. Without it a midnight-UTC
      // instant formats as the day BEFORE on any negative-offset machine, and
      // the estimate appears to be due a day earlier than anybody chose.
      expect(formatDueDate(due('2026-09-12'))).toBe('12 Sept 2026');
      expect(formatDueDate(due('2026-01-01'))).toBe('1 Jan 2026');
    });
  });
});
