import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * AEH-239. Who may delete a generated document, and when.
 *
 * Two guards, both easy to lose in a refactor and neither visible when it goes:
 *
 * 1. ADMIN only. A generated artifact may already have been sent to a client,
 *    and `createdBy` records who pressed the button rather than who owns it —
 *    so unlike an estimate there is no owner to fall back on.
 * 2. Never while it is generating. An Inngest function is writing to that row;
 *    deleting it underneath produces a cascade of confusing failures for
 *    something the user experiences as one click.
 */

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const findUnique = vi.fn();
const del = vi.fn();
const update = vi.fn();
vi.mock('@repo/db', () => ({
  prisma: {
    estimateArtifact: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      delete: (...a: unknown[]) => del(...a),
      update: (...a: unknown[]) => update(...a),
    },
  },
}));

const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

import { auth } from '@/lib/auth';
import { deleteArtifact, renameArtifact } from './actions';

const mockAuth = auth as unknown as ReturnType<typeof vi.fn>;
const ARTIFACT = 'art-1';

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({ status: 'DONE' });
  del.mockResolvedValue({});
  update.mockResolvedValue({ estimateId: 'est-1' });
});

describe('deleteArtifact authorization', () => {
  it('lets an admin delete a finished document', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    await deleteArtifact(ARTIFACT);
    expect(del).toHaveBeenCalledWith({ where: { id: ARTIFACT } });
  });

  it('refuses an estimator, even one who generated it', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'ESTIMATOR' } });
    await expect(deleteArtifact(ARTIFACT)).rejects.toThrow();
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    mockAuth.mockResolvedValue(null);
    await expect(deleteArtifact(ARTIFACT)).rejects.toThrow();
    expect(del).not.toHaveBeenCalled();
  });
});

describe('deleteArtifact state guard', () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
  });

  it('deletes a failed document — the main reason this exists', async () => {
    findUnique.mockResolvedValue({ status: 'FAILED' });
    await deleteArtifact(ARTIFACT);
    expect(del).toHaveBeenCalled();
  });

  it('refuses while a generation is in flight, and says why', async () => {
    findUnique.mockResolvedValue({ status: 'RUNNING' });
    await expect(deleteArtifact(ARTIFACT)).rejects.toThrow(/still being generated/);
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses a queued document too', async () => {
    // IDLE is the gap between the row being created and the first step
    // reporting. An event is already in flight for it.
    findUnique.mockResolvedValue({ status: 'IDLE' });
    await expect(deleteArtifact(ARTIFACT)).rejects.toThrow(/still being generated/);
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses one that no longer exists rather than reporting success', async () => {
    findUnique.mockResolvedValue(null);
    await expect(deleteArtifact(ARTIFACT)).rejects.toThrow(/not found/i);
    expect(del).not.toHaveBeenCalled();
  });
});

/**
 * Renaming, which is a deliberately LOWER bar than deleting.
 *
 * An artifact is created under its type's name and nothing else ever writes
 * that column — the generation run does not, which is what makes the name
 * stable and safe to edit mid-generation. So these tests pin the two halves
 * that would go unnoticed if they broke: who is allowed to rename, and that an
 * empty name can never land.
 */
describe('renameArtifact', () => {
  it('lets a non-admin rename — the person sending it names it', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'ESTIMATOR' } });
    await renameArtifact(ARTIFACT, 'ERD — lean scenario');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ARTIFACT },
        data: { title: 'ERD — lean scenario' },
      }),
    );
  });

  it('refuses an unauthenticated caller', async () => {
    mockAuth.mockResolvedValue(null);
    await expect(renameArtifact(ARTIFACT, 'Anything')).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it('trims, so a stray space cannot become part of the name', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'ESTIMATOR' } });
    await renameArtifact(ARTIFACT, '  Data Flow Diagram  ');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { title: 'Data Flow Diagram' } }),
    );
  });

  it('writes nothing for an empty or whitespace name', async () => {
    // The field would be left blank in the masthead and the panel row, with
    // nothing to click back into.
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'ESTIMATOR' } });
    await renameArtifact(ARTIFACT, '   ');
    await renameArtifact(ARTIFACT, '');
    expect(update).not.toHaveBeenCalled();
  });

  it('caps the length rather than rejecting a long name', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'ESTIMATOR' } });
    await renameArtifact(ARTIFACT, 'x'.repeat(400));
    const arg = update.mock.calls[0]![0] as { data: { title: string } };
    expect(arg.data.title).toHaveLength(200);
  });

  it('revalidates the estimate page, which lists artifacts by title', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'ESTIMATOR' } });
    await renameArtifact(ARTIFACT, 'Renamed');
    expect(revalidatePath).toHaveBeenCalledWith('/estimates/est-1');
  });
});
