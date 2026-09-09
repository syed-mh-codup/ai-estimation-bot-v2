import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Architect marks a card `notSafelyRemovable` when another requirement
 * declares a Requires-edge onto its work: switching it off does not trim scope,
 * it trims scope something else is standing on. That judgment was computed and
 * persisted on every run and then read by nothing, so the editor let a BA
 * switch off a foundation card the pipeline knew was load bearing — AEH-228's
 * headline finding, cleared in AEH-253.
 *
 * The disabled button in the editor is a courtesy. A server action is reachable
 * without the page that rendered it, so these tests pin the server-side gate.
 */

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const menuItemFindUnique = vi.fn();
const menuItemUpdate = vi.fn();
const estimateFindUnique = vi.fn();
vi.mock('@repo/db', () => ({
  prisma: {
    menuItem: {
      findUnique: (...a: unknown[]) => menuItemFindUnique(...a),
      update: (...a: unknown[]) => menuItemUpdate(...a),
    },
    estimate: { findUnique: (...a: unknown[]) => estimateFindUnique(...a) },
    // No `ledgerLock` stub, and its absence is load-bearing: switching a card
    // off is NOT lock-guarded. It briefly was, on the reasoning that removing
    // the card removes its hours from every total — but a lock speaks about a
    // line's hours and description, and disabling a card edits neither. If a
    // ledger-lock query ever creeps back into this path, these tests fail on a
    // missing mock rather than passing quietly. The Architect's judgment is
    // what this file tests.
  },
}));

import { auth } from '@/lib/auth';
import { setItemEnabled } from './actions';
import { cardFlags } from './dto';

const mockAuth = auth as unknown as ReturnType<typeof vi.fn>;
const ITEM = 'item-1';

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'ESTIMATOR' } });
  estimateFindUnique.mockResolvedValue({ status: 'REVIEW' });
  menuItemUpdate.mockResolvedValue({});
});

function card(meta: unknown) {
  menuItemFindUnique.mockResolvedValue({ estimateId: 'est-1', title: 'Auth & accounts', meta });
}

describe('setItemEnabled honours the Architect’s judgment', () => {
  it('switches off an ordinary card', async () => {
    card({ toggleable: true, notSafelyRemovable: false, thinSlice: false });
    expect(await setItemEnabled(ITEM, false)).toEqual({ kind: 'ok' });
    expect(menuItemUpdate).toHaveBeenCalledWith({ where: { id: ITEM }, data: { enabled: false } });
  });

  it('refuses to switch off a card other scope depends on, and writes nothing', async () => {
    card({ toggleable: false, notSafelyRemovable: true, thinSlice: false });
    expect(await setItemEnabled(ITEM, false)).toMatchObject({
      kind: 'refused',
      error: expect.stringMatching(/depends on it/),
    });
    expect(menuItemUpdate).not.toHaveBeenCalled();
  });

  it('names the card in the refusal, so the banner is actionable', async () => {
    card({ notSafelyRemovable: true });
    const out = await setItemEnabled(ITEM, false);
    expect(out.kind === 'refused' && out.error).toMatch(/Auth & accounts/);
  });

  it('refuses a card the Architect marked non-optional even when it is removable', async () => {
    card({ toggleable: false, notSafelyRemovable: false, thinSlice: false });
    expect(await setItemEnabled(ITEM, false)).toMatchObject({
      kind: 'refused',
      error: expect.stringMatching(/not optional scope/),
    });
    expect(menuItemUpdate).not.toHaveBeenCalled();
  });

  /**
   * The regression this whole shape exists for. A refusal used to be `throw new
   * Error(sentence)`, and React's Flight client discards the message of an error
   * thrown inside a `'use server'` action in a production build — so a deployed
   * reviewer got "An error occurred in the Server Components render…" in the
   * ledger's banner and no idea which card, which locks, or what to do. Asserted
   * as "does not reject" rather than by matching text, because that is the
   * property that breaks: the sentence is fine, the delivery was not.
   */
  it('RETURNS its refusals rather than throwing, so the text survives a prod build', async () => {
    for (const meta of [{ notSafelyRemovable: true }, { toggleable: false }]) {
      card(meta);
      const out = await setItemEnabled(ITEM, false);
      expect(out.kind).toBe('refused');
      expect(out.kind === 'refused' && out.error).not.toMatch(/Server Components/);
    }
  });

  /**
   * The gate is about removing scope something stands on, never about adding it.
   * A load-bearing card that is currently off must always be switchable back on,
   * or an estimator who disabled one before this shipped could never recover it.
   */
  it('always allows switching a card back ON, load bearing or not', async () => {
    card({ toggleable: false, notSafelyRemovable: true, thinSlice: false });
    expect(await setItemEnabled(ITEM, true)).toEqual({ kind: 'ok' });
    expect(menuItemUpdate).toHaveBeenCalledWith({ where: { id: ITEM }, data: { enabled: true } });
  });

  /**
   * Rows predating the envelope — and the e2e fixtures, which create menu items
   * with no `meta` at all — must read as ordinary cards. "The Architect never
   * said" means the estimator decides, not that everything is locked.
   */
  it('treats a card with no meta as freely toggleable', async () => {
    card(null);
    expect(await setItemEnabled(ITEM, false)).toEqual({ kind: 'ok' });
    expect(menuItemUpdate).toHaveBeenCalledWith({ where: { id: ITEM }, data: { enabled: false } });
  });

  it('refuses a missing card rather than falling through to update', async () => {
    menuItemFindUnique.mockResolvedValue(null);
    await expect(setItemEnabled(ITEM, false)).rejects.toThrow(/not found/i);
    expect(menuItemUpdate).not.toHaveBeenCalled();
  });

  it('still refuses to edit a finalised estimate', async () => {
    card({});
    estimateFindUnique.mockResolvedValue({ status: 'FINALISED' });
    await expect(setItemEnabled(ITEM, false)).rejects.toThrow(/finalised/i);
    expect(menuItemUpdate).not.toHaveBeenCalled();
  });
});

describe('cardFlags', () => {
  it('defaults permissively for absent, null and empty meta', () => {
    for (const meta of [null, {}, undefined]) {
      expect(cardFlags(meta as never)).toEqual({
        toggleable: true,
        notSafelyRemovable: false,
        thinSlice: false,
      });
    }
  });

  it('reads what the Architect actually wrote', () => {
    expect(cardFlags({ toggleable: false, notSafelyRemovable: true, thinSlice: true } as never)).toEqual({
      toggleable: false,
      notSafelyRemovable: true,
      thinSlice: true,
    });
  });

  it('is not fooled by a non-object meta', () => {
    expect(cardFlags('nonsense' as never).notSafelyRemovable).toBe(false);
  });
});
