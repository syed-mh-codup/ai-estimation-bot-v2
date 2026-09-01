import type { AgentKind, UsageKind } from './generated/client/index.js';
import { agentProfile } from './agent-catalogue';

/**
 * The single source of truth for the `UsageKind` set — the attribution
 * vocabulary for ModelUsage rows.
 *
 * Before this existed the agent list lived in four places and drifted; the same
 * discipline is applied here from the start. The run crew + Oracle values are
 * literally the `AgentKind` strings, so there is no second spelling of
 * "LIBRARIAN" to keep in step. INGEST and PRESET_EMBEDDING are the only
 * additions, and they are model surfaces, not agents. PRESET_EMBEDDING is named
 * for what it actually covers — the library backfill sweep — because an
 * Archivist query embed is recorded as ARCHIVIST, so a bare "EMBEDDING" would
 * have read as "all embedding spend" and it never was.
 */

export type UsageProfile = {
  kind: UsageKind;
  label: string;
};

/**
 * Agent-shaped usage kinds, keyed by AgentKind. `SUPERVISOR` is reserved for
 * catalogue completeness — it has no runtime model call — but it belongs here so
 * the enum and this map cannot disagree about the shape of the agent vocabulary.
 */
export const AGENT_USAGE_KIND: Record<AgentKind, UsageKind> = {
  SUPERVISOR: 'SUPERVISOR',
  LIBRARIAN: 'LIBRARIAN',
  DETECTIVE: 'DETECTIVE',
  ARCHIVIST: 'ARCHIVIST',
  SPECIALIST_DEV: 'SPECIALIST_DEV',
  SPECIALIST_QA: 'SPECIALIST_QA',
  SPECIALIST_PM: 'SPECIALIST_PM',
  SPECIALIST_BA: 'SPECIALIST_BA',
  ARCHITECT: 'ARCHITECT',
  ORACLE: 'ORACLE',
};

/** The model surfaces that are not agents. */
const EXTRA_USAGE_PROFILES: UsageProfile[] = [
  { kind: 'INGEST', label: 'Ingestion' },
  { kind: 'PRESET_EMBEDDING', label: 'Preset embedding' },
];

export const USAGE_PROFILES: UsageProfile[] = [
  ...(Object.entries(AGENT_USAGE_KIND) as [AgentKind, UsageKind][]).map(([agentKind, kind]) => ({
    kind,
    label: agentProfile(agentKind).label,
  })),
  ...EXTRA_USAGE_PROFILES,
];

export function usageProfile(kind: UsageKind): UsageProfile {
  const found = USAGE_PROFILES.find((p) => p.kind === kind);
  // Unreachable while the completeness test passes; throwing beats rendering a
  // blank cell on the report.
  if (!found) throw new Error(`No usage profile for kind: ${kind}`);
  return found;
}

export function usageLabel(kind: UsageKind): string {
  return usageProfile(kind).label;
}
