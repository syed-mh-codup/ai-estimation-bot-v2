import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Custody can be handed to anyone by anyone who is signed in — that follows the
 * shared-ledger stance the rest of this app takes. What does not follow is
 * being made accountable for a deadline and only finding out when the first
 * nudge arrives, so assignment sends a note.
 *
 * These pin the two things that make that note trustworthy: it goes out when
 * custody actually changes hands, and it does NOT go out otherwise.
 */

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const estFindUnique = vi.fn();
const estUpdate = vi.fn();
const userFindUnique = vi.fn();
vi.mock('@repo/db', () => ({
  prisma: {
    estimate: {
      findUnique: (...a: unknown[]) => estFindUnique(...a),
      update: (...a: unknown[]) => estUpdate(...a),
    },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
  },
}));

// Run the deferred work inline so the assertions can see it. In the app this is
// what keeps an SMTP round trip out of the picker's optimistic transition.
vi.mock('next/server', () => ({ after: (fn: () => unknown) => fn() }));

const sendCustodyAssignedEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendCustodyAssignedEmail: (...a: unknown[]) => sendCustodyAssignedEmail(...a),
}));

import { auth } from '@/lib/auth';
import { setCustodian } from './actions';

const mockAuth = auth as unknown as ReturnType<typeof vi.fn>;

const ACTOR = 'user-actor';
const TARGET = 'user-target';
const ESTIMATE = 'est-1';
const DUE = new Date('2026-09-12T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: ACTOR, role: 'ESTIMATOR' } });
  estFindUnique.mockResolvedValue({
    status: 'DRAFT',
    title: 'Acme client portal',
    dueAt: DUE,
    custodianId: null,
  });
  estUpdate.mockResolvedValue({});
  userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === TARGET
      ? { name: 'Casey', email: 'casey@codup.co', disabledAt: null }
      : { name: 'Sam', email: 'sam@codup.co' },
  );
  sendCustodyAssignedEmail.mockResolvedValue({ sent: true });
});

describe('setCustodian', () => {
  it('assigns custody and tells the new custodian', async () => {
    await setCustodian(ESTIMATE, TARGET);

    expect(estUpdate).toHaveBeenCalledWith({
      where: { id: ESTIMATE },
      data: { custodianId: TARGET },
    });
    expect(sendCustodyAssignedEmail).toHaveBeenCalledTimes(1);
    expect(sendCustodyAssignedEmail.mock.calls[0]![0]).toMatchObject({
      to: 'casey@codup.co',
      name: 'Casey',
      title: 'Acme client portal',
      estimateId: ESTIMATE,
      dueAt: DUE,
      assignedBy: 'Sam',
    });
  });

  it('does nothing at all when the same person is re-submitted', async () => {
    // The picker fires on change, but a stray re-submit must not re-notify —
    // "this is now yours" twice for one handover reads as a system fault.
    estFindUnique.mockResolvedValue({
      status: 'DRAFT',
      title: 'Acme client portal',
      dueAt: DUE,
      custodianId: TARGET,
    });

    await setCustodian(ESTIMATE, TARGET);

    expect(estUpdate).not.toHaveBeenCalled();
    expect(sendCustodyAssignedEmail).not.toHaveBeenCalled();
  });

  it('does not email you when you take custody yourself', async () => {
    await setCustodian(ESTIMATE, ACTOR);

    expect(estUpdate).toHaveBeenCalled();
    expect(sendCustodyAssignedEmail).not.toHaveBeenCalled();
  });

  it('clears custody without emailing anyone', async () => {
    estFindUnique.mockResolvedValue({
      status: 'DRAFT',
      title: 'Acme client portal',
      dueAt: DUE,
      custodianId: TARGET,
    });

    await setCustodian(ESTIMATE, null);

    expect(estUpdate).toHaveBeenCalledWith({
      where: { id: ESTIMATE },
      data: { custodianId: null },
    });
    expect(sendCustodyAssignedEmail).not.toHaveBeenCalled();
  });

  it('refuses a disabled account, and changes nothing', async () => {
    userFindUnique.mockResolvedValue({
      name: 'Gone',
      email: 'gone@codup.co',
      disabledAt: new Date('2026-08-01'),
    });

    await expect(setCustodian(ESTIMATE, TARGET)).rejects.toThrow(/disabled/);
    expect(estUpdate).not.toHaveBeenCalled();
    expect(sendCustodyAssignedEmail).not.toHaveBeenCalled();
  });

  it('refuses to touch a finalised estimate', async () => {
    estFindUnique.mockResolvedValue({
      status: 'FINALISED',
      title: 'Acme client portal',
      dueAt: DUE,
      custodianId: null,
    });

    await expect(setCustodian(ESTIMATE, TARGET)).rejects.toThrow(/finalised/i);
    expect(estUpdate).not.toHaveBeenCalled();
    expect(sendCustodyAssignedEmail).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    mockAuth.mockResolvedValue(null);
    await expect(setCustodian(ESTIMATE, TARGET)).rejects.toThrow();
    expect(estUpdate).not.toHaveBeenCalled();
  });

  it('still changes custody when the notice fails', async () => {
    // SMTP is an optional integration. Reverting the picker because a mail
    // server was down would be the wrong half of the operation to trust.
    sendCustodyAssignedEmail.mockRejectedValue(new Error('smtp down'));

    await expect(setCustodian(ESTIMATE, TARGET)).resolves.toBeUndefined();
    expect(estUpdate).toHaveBeenCalled();
  });
});
