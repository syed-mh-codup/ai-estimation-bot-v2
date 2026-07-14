import type { ArchivistMatch, MenuItem, Requirement, RiskFinding, SpecialistOutput } from '@repo/shared';
import { FOUR_HOUR_CAP } from '@repo/shared';

export type SupervisorGateInput = {
  requirements: Requirement[];
  archivistMatches: ArchivistMatch[];
  riskFindings: RiskFinding[];
  specialistOutputs: SpecialistOutput[];
  menuItems: MenuItem[];
  consistencyFlags: string[];
};

/**
 * Deterministic checks against the live SUPERVISOR prompt's GATES section.
 *
 * This is NOT the full reject-and-return-to-agent retry loop the prompt
 * describes (SUPERVISOR: "Gate after every stage. Do not advance a stage
 * until its gate passes.") — that needs per-stage retry plumbing that's a
 * separate, larger effort. This is the honest subset: the same invariants,
 * checked and surfaced as warnings after the fact, so a violation is visible
 * (in agentState.gateWarnings and server logs) instead of silently passing.
 */
export function checkSupervisorGates(input: SupervisorGateInput): string[] {
  const warnings: string[] = [];
  const { requirements, archivistMatches, riskFindings, specialistOutputs, menuItems, consistencyFlags } = input;

  const matchByRequirementId = new Map(archivistMatches.map((m) => [m.requirementId, m]));
  const highRiskRequirementIds = new Set(
    riskFindings.filter((r) => r.riskFlags.length > 0 || r.spikeRecommended).map((r) => r.requirementId),
  );

  // ── After Stage 2: every requirement has coverage full/partial, or an
  //    explicit coverage:none net-new path AND (if High-risk) a Detective
  //    finding on record. ──────────────────────────────────────────────────
  for (const req of requirements) {
    const match = matchByRequirementId.get(req.id);
    if (!match) {
      warnings.push(`Stage 2: requirement ${req.id} has no Archivist match at all (expected an explicit coverage:none).`);
      continue;
    }
    if (match.coverage === 'none' && req.blocksEstimation && !highRiskRequirementIds.has(req.id)) {
      warnings.push(`Stage 2: requirement ${req.id} blocks estimation with coverage:none but has no Detective finding.`);
    }
  }

  // ── After Stage 3: FOUR-HOUR RULE + coverage (every requirement has >=1
  //    DEV line item unless it's pure BA/PM/QA scope) + proportionality. ────
  const devByRequirement = new Map<string, number>();
  const qaByRequirement = new Map<string, number>();
  const totalsByRole: Record<'DEV' | 'QA' | 'PM' | 'BA', number> = { DEV: 0, QA: 0, PM: 0, BA: 0 };

  for (const output of specialistOutputs) {
    const role: 'DEV' | 'QA' | 'PM' | 'BA' = output.role;
    for (const li of output.lineItems) {
      if (li.hours > FOUR_HOUR_CAP) {
        warnings.push(`Stage 3: line item ${li.id} (${output.role}) is ${li.hours}h, over the four-hour cap.`);
      }
      totalsByRole[role] += li.hours;
      if (output.role === 'DEV') devByRequirement.set(li.requirementId, (devByRequirement.get(li.requirementId) ?? 0) + li.hours);
      if (output.role === 'QA') qaByRequirement.set(li.requirementId, (qaByRequirement.get(li.requirementId) ?? 0) + li.hours);
    }
  }
  for (const req of requirements) {
    if (!devByRequirement.has(req.id)) {
      warnings.push(`Stage 3: requirement ${req.id} has no DEV line item.`);
    }
  }
  if (totalsByRole.DEV > 0) {
    const qaRatio = totalsByRole.QA / totalsByRole.DEV;
    if (qaRatio < 0.15 || qaRatio > 0.6) {
      warnings.push(`Stage 3: QA total is ${(qaRatio * 100).toFixed(0)}% of DEV (expected 15-60%) — flagged, not auto-rejected.`);
    }
    const nonDev = totalsByRole.DEV + totalsByRole.QA + totalsByRole.BA;
    const pmRatio = nonDev > 0 ? totalsByRole.PM / (totalsByRole.DEV + totalsByRole.QA + totalsByRole.BA) : 0;
    if (pmRatio < 0.08 || pmRatio > 0.25) {
      warnings.push(`Stage 3: PM total is ${(pmRatio * 100).toFixed(0)}% of DEV+QA+BA (expected 8-25%) — flagged, not auto-rejected.`);
    }
    const baRatio = totalsByRole.BA / totalsByRole.DEV;
    if (baRatio > 0.3) {
      warnings.push(`Stage 3: BA total is ${(baRatio * 100).toFixed(0)}% of DEV (expected <=30%) — flagged, not auto-rejected.`);
    }
  }

  // ── After Stage 4: every line item under exactly one card, no orphans, no
  //    empty cards, grand total reconciles, open questions surfaced. ────────
  warnings.push(...consistencyFlags.map((f) => `Stage 4: ${f}`));

  const cardIdByLineItemId = new Map<string, string>();
  for (const card of menuItems) {
    for (const li of card.lineItems) {
      if (li.id && cardIdByLineItemId.has(li.id)) {
        warnings.push(`Stage 4: line item ${li.id} appears under more than one menu card.`);
      }
      if (li.id) cardIdByLineItemId.set(li.id, card.id);
    }
  }

  return warnings;
}
