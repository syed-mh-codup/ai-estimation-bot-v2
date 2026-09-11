import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Renaming a project writes the members nobody can see. AEH-375.
 *
 * `projectName` is denormalised onto every member of a family, and every READ
 * of a family now skips deleted estimates. Taking that filter into the rename
 * too looks consistent and is wrong: the deleted member keeps the old name,
 * and recovering it puts an estimate back into the family under a name the
 * rest of it stopped using. `projectNameOf` returns the first non-null it is
 * given, in caller order, so the family would then show one name or the other
 * depending on how the dashboard happened to sort that day — which is the
 * kind of bug that reproduces on Tuesdays.
 *
 * The rule these pin: validate against what the caller can see, write across
 * the whole family.
 */

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const findMany = vi.fn();
const updateMany = vi.fn();
vi.mock('@repo/db', async () => {
  // The lineage helpers are pure and are the thing under test alongside the
  // action, so they are NOT mocked.
  const actual = await vi.importActual<typeof import('@repo/db')>('@repo/db');
  return {
    ...actual,
    prisma: {
      estimate: {
        findMany: (...a: unknown[]) => findMany(...a),
        updateMany: (...a: unknown[]) => updateMany(...a),
      },
    },
  };
});

import { auth } from '@/lib/auth';
import { renameProject } from './lineage-actions';

const mockAuth = auth as unknown as ReturnType<typeof vi.fn>;

const PARENT = 'est-parent';
const CHILD = 'est-child';
const STRANGER = 'est-unrelated';

/** Every row, as the unfiltered read returns it. */
const ALL = [
  { id: PARENT, parentId: null, projectName: 'Acme CRM', title: 'round 1' },
  { id: CHILD, parentId: PARENT, projectName: 'Acme CRM', title: 'round 2' },
  { id: STRANGER, parentId: null, projectName: 'Other', title: 'something else' },
];
/** What a live read returns while the PARENT is deleted. */
const VISIBLE = ALL.filter((n) => n.id !== PARENT);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'ESTIMATOR' } });
  updateMany.mockResolvedValue({ count: 2 });
  // First call is the visible set (validation), second is the full set (write).
  findMany.mockResolvedValueOnce(VISIBLE).mockResolvedValueOnce(ALL);
});

describe('renameProject with a deleted family member', () => {
  it('renames the deleted parent along with the visible child', async () => {
    const out = await renameProject(CHILD, 'Acme Platform');
    expect(out).toEqual({ kind: 'ok' });

    const [args] = updateMany.mock.calls[0] as [
      { where: { id: { in: string[] } }; data: { projectName: string } },
    ];
    expect(args.data.projectName).toBe('Acme Platform');
    // The deleted parent is in the write set. Without it, recovering the
    // parent brings back an estimate still called "Acme CRM".
    expect([...args.where.id.in].sort()).toEqual([CHILD, PARENT].sort());
  });

  it('never reaches outside the family', async () => {
    await renameProject(CHILD, 'Acme Platform');
    const [args] = updateMany.mock.calls[0] as [{ where: { id: { in: string[] } } }];
    expect(args.where.id.in).not.toContain(STRANGER);
  });

  it('validates the target against what the caller can see', async () => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'ESTIMATOR' } });
    // Renaming FROM the deleted parent: it is not in the visible set, so the
    // action refuses rather than letting somebody rename a family through an
    // estimate they cannot open.
    findMany.mockResolvedValueOnce(VISIBLE).mockResolvedValueOnce(ALL);
    const out = await renameProject(PARENT, 'Acme Platform');
    expect(out).toEqual({ kind: 'refused', error: expect.stringMatching(/no longer exists/) });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('reads the visible set before the full one', async () => {
    // Ordering is load-bearing: the two reads differ, and swapping them would
    // silently validate against rows the caller cannot see.
    await renameProject(CHILD, 'Acme Platform');
    expect(findMany.mock.calls[0]![0]).toMatchObject({ where: { deletedAt: null } });
    expect(findMany.mock.calls[1]![0]).not.toHaveProperty('where');
  });
});
