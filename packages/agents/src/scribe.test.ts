import { describe, expect, it, vi } from 'vitest';

import type { ChatResult, IModelProvider } from '@repo/providers';

import { runScribe, type ScribableStatement } from './scribe';

/**
 * AEH-238. The Scribe rewrites the narrative and the assumptions.
 *
 * The model is faked, so what these guard is everything AROUND the call — and
 * on this axis the dangerous failures are all about the boundary rather than
 * about words:
 *
 * A ref pointing at a LOCKED line would write over something somebody froze.
 * A ref pointing outside the selection would write outside the envelope the
 * person declared. A ref that does not exist would write nowhere, or worse,
 * onto whatever happens to sit at that index. And wording returned unchanged,
 * if written, would restamp a line nobody edited as `STEERED` and bump the
 * `updatedAt` a later edit reads as staleness.
 *
 * All four are handed to it on purpose below. An implementation that trusted
 * its input would pass a test that only checked the happy path.
 */

function providerReturning(payload: unknown): IModelProvider {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    chat: vi.fn().mockResolvedValue({ text, model: 'stub/model', usage: null } satisfies ChatResult),
    chatStream: async function* () {
      yield { type: 'delta' as const, text };
      yield { type: 'done' as const, usage: null, model: 'stub/model' };
    },
    embed: vi.fn(),
  } as unknown as IModelProvider;
}

const ctxWith = (payload: unknown) => ({
  modelProvider: providerReturning(payload),
  modelString: 'stub/model',
  instructions: 'You are the Scribe.',
  recorder: { record: vi.fn() },
  levers: undefined,
});

/** Four assumptions: two ticked, one untouched, one frozen. */
const STATEMENTS: ScribableStatement[] = [
  { statementId: 's1', text: 'Auth already exists.', inEnvelope: true, locked: false },
  { statementId: 's2', text: 'Auth is in place.', inEnvelope: true, locked: false },
  { statementId: 's3', text: 'No data migration.', inEnvelope: false, locked: false },
  { statementId: 's4', text: 'The provider stays.', inEnvelope: false, locked: true },
];

const ARGS = {
  kindLabel: 'assumptions',
  statements: STATEMENTS,
  instruction: 'these two say the same thing',
  ledgerContext: '- Checkout — DEV 40h',
};

describe('runScribe', () => {
  it('returns wording for the ticked lines, resolved to real ids', async () => {
    const out = await runScribe(
      ARGS,
      ctxWith({
        lines: [
          { ref: 1, text: 'Authentication already exists and is reused.' },
          { ref: 2, text: '' },
        ],
        notes: 'Merged the two auth assumptions.',
      }),
    );

    expect(out.lines).toEqual([
      { statementId: 's1', text: 'Authentication already exists and is reused.' },
      // An empty string is how a merge deletes the absorbed line.
      { statementId: 's2', text: '' },
    ]);
    expect(out.notes).toBe('Merged the two auth assumptions.');
  });

  it('drops a ref pointing at a LOCKED line, and says so', async () => {
    const out = await runScribe(
      ARGS,
      ctxWith({ lines: [{ ref: 4, text: 'The provider is being replaced.' }] }),
    );
    expect(out.lines).toEqual([]);
    expect(out.notes).toMatch(/locked line/);
    // The applier refuses the whole write if a lock is touched; this is the
    // earlier, gentler line of the same defence, and it can explain itself.
    expect(out.notes).toMatch(/envelope does not cover/);
  });

  it('drops a ref outside the selection', async () => {
    const out = await runScribe(
      ARGS,
      ctxWith({ lines: [{ ref: 3, text: 'Data is migrated after all.' }] }),
    );
    expect(out.lines).toEqual([]);
    expect(out.notes).toMatch(/outside the selection/);
  });

  it('drops a ref that is not in the list at all', async () => {
    const out = await runScribe(ARGS, ctxWith({ lines: [{ ref: 9, text: 'Invented.' }] }));
    expect(out.lines).toEqual([]);
    expect(out.notes).toMatch(/not in the list/);
  });

  it('drops wording identical to what is already there', async () => {
    const out = await runScribe(
      ARGS,
      // Restating a line unchanged is not a change. Writing it would restamp a
      // line nobody edited as STEERED and move its `updatedAt`.
      ctxWith({ lines: [{ ref: 1, text: '  Auth already exists.  ' }] }),
    );
    expect(out.lines).toEqual([]);
  });

  it('keeps only the first entry when a ref is returned twice', async () => {
    const out = await runScribe(
      ARGS,
      ctxWith({
        lines: [
          { ref: 1, text: 'First answer.' },
          { ref: 1, text: 'Second answer.' },
        ],
      }),
    );
    expect(out.lines).toEqual([{ statementId: 's1', text: 'First answer.' }]);
  });

  it('does not call the model when the selection is entirely locked', async () => {
    const provider = providerReturning({ lines: [] });
    const out = await runScribe(
      {
        ...ARGS,
        statements: [
          { statementId: 's4', text: 'The provider stays.', inEnvelope: true, locked: true },
        ],
      },
      {
        modelProvider: provider,
        modelString: 'stub/model',
        instructions: 'You are the Scribe.',
        recorder: { record: vi.fn() },
        levers: undefined,
      },
    );
    expect(out.lines).toEqual([]);
    expect(out.notes).toMatch(/locked or absent/);
    // Paying for a call that cannot write anything is the wrong kind of honest.
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('accepts an answer that changes nothing', async () => {
    const out = await runScribe(
      ARGS,
      // The model declining is a legitimate answer: an assumption is often
      // wrong because the WORK is wrong, and rewording it would hide that.
      ctxWith({ lines: [], notes: 'The hours are what disagree with this, not the wording.' }),
    );
    expect(out.lines).toEqual([]);
    expect(out.notes).toBe('The hours are what disagree with this, not the wording.');
  });

  it('shows the model every line in the list, marked, not just the ticked ones', async () => {
    const provider = providerReturning({ lines: [] });
    await runScribe(ARGS, {
      modelProvider: provider,
      modelString: 'stub/model',
      instructions: 'You are the Scribe.',
      recorder: { record: vi.fn() },
      levers: undefined,
    });

    const chat = provider.chat as unknown as ReturnType<typeof vi.fn>;
    const sent = String(chat.mock.calls[0]?.[0]?.messages?.[1]?.content ?? '');
    // It cannot merge a ticked line into an untouched neighbour, or avoid
    // repeating what a locked one says, if it cannot see them.
    expect(sent).toContain('No data migration.');
    expect(sent).toContain('The provider stays.');
    expect(sent).toContain('LOCKED');
    expect(sent).toContain('not selected');
    // And it is told which numbers it may answer for.
    expect(sent).toContain('1, 2');
  });
});
