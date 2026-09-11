import { describe, it, expect } from 'vitest';
import { MARK_KEYS, MARK_LABEL } from './marks';
import { BEATS, NOTATION, NOTATION_CLOSING } from './notation';

const entries = NOTATION.flatMap((g) => g.entries);

describe('the reference sheet', () => {
  /**
   * The one that earns the file. A mark added to the ledger and not written
   * down here is a mark nobody can look up — and it fails silently, because
   * the sheet still renders perfectly without it.
   */
  it('documents every mark the filter row can offer', () => {
    const documented = entries.map((e) => e.mark).filter(Boolean);
    for (const key of MARK_KEYS) {
      expect(documented, `${MARK_LABEL[key]} (${key}) is not in the reference sheet`).toContain(key);
    }
  });

  it('documents each of them exactly once', () => {
    const documented = entries.map((e) => e.mark).filter(Boolean);
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('has no entry claiming a mark that does not exist', () => {
    for (const entry of entries) {
      if (entry.mark) expect(MARK_KEYS).toContain(entry.mark);
    }
  });

  it('gives every entry both an answer and a reason', () => {
    for (const entry of entries) {
      expect(entry.meaning.length, JSON.stringify(entry.sample)).toBeGreaterThan(0);
      expect(entry.note.length, JSON.stringify(entry.sample)).toBeGreaterThan(0);
      // The meaning is the line you read at a glance; once it runs past a
      // sentence it is the note, and the entry has two notes and no answer.
      expect(entry.meaning.length, `too long to skim: ${entry.meaning}`).toBeLessThan(140);
    }
  });

  it('asks a question of every group', () => {
    for (const group of NOTATION) {
      expect(group.question.endsWith('?')).toBe(true);
      expect(group.entries.length).toBeGreaterThan(0);
    }
  });

  /**
   * Four, and the number is load-bearing. The walkthrough is about the
   * notation rather than the layout precisely so it can stay this short; a
   * fifth beat is the first sign it has started describing the furniture.
   */
  it('keeps the walkthrough to four beats', () => {
    expect(BEATS).toHaveLength(4);
    for (const beat of BEATS) {
      expect(beat.title.length).toBeGreaterThan(0);
      expect(beat.body.length).toBeGreaterThan(0);
    }
  });

  it('ends on the rule the rest of it depends on', () => {
    expect(NOTATION_CLOSING).toContain('Colour never travels alone');
  });
});
