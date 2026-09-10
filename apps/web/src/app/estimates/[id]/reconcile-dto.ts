import type { ProposalDecision, ProposalKind, ReconciliationStatus } from '@repo/db';

/** One proposed change, as the review renders it. */
export type ProposalDTO = {
  id: string;
  menuItemId: string | null;
  kind: ProposalKind;
  title: string;
  rationale: string;
  supersedes: string[];
  /**
    * How much this proposal moves, in base hours. Positive adds, negative drops.
    *
    * One figure rather than the two columns behind it, because the review only
    * ever shows the difference — and computing it here makes it a real read of
    * `hoursBefore`/`hoursAfter` rather than a copy the field audit cannot see
    * through, which is how live columns end up reported as orphans.
    */
  delta: number;
  decision: ProposalDecision;
  /**
   * The proposed rows, role by role.
   *
   * Sent with the proposal rather than fetched on expand: a person deciding on
   * a card needs to see what the hours are FOR, and a proposal whose detail
   * arrives after a click is one people accept without reading.
   */
  rows: { role: string; title: string; baseHours: number; taxedHours: number }[];
};

/** A whole pass, as the review renders it. */
export type ReconciliationDTO = {
  id: string;
  status: ReconciliationStatus;
  stage: string | null;
  pct: number;
  error: string | null;
  prompt: string;
  posture: 'SUCCESSOR' | 'BRANCH';
  reasoning: string | null;
  triageReasoning: string | null;
  /** How many cards triage put in play, so a too-narrow pass is visible. */
  triagedCount: number;
  /**
   * Whether the Librarian's read survived the failure, so a resume can skip it.
   *
   * A boolean rather than the requirement set itself: the review only needs to
   * say what resuming will save, and the blob behind this is large enough that
   * sending it on a polled route would cost more than the answer is worth.
   */
  briefAlreadyRead: boolean;
  proposals: ProposalDTO[];
  createdAt: string;
  appliedAt: string | null;
};

/** Net movement across everything still undecided or accepted. */
export function netHours(proposals: ProposalDTO[]): number {
  return proposals.filter((p) => p.decision !== 'REJECTED').reduce((n, p) => n + p.delta, 0);
}
