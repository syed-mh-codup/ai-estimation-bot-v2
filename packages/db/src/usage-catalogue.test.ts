import { describe, expect, it } from 'vitest';
import { UsageKind } from './generated/client/index.js';
import { AGENT_USAGE_KIND, USAGE_PROFILES, usageProfile } from './usage-catalogue';
import { AGENT_KINDS } from './agent-catalogue';

/**
 * The point of the catalogue is that the usage vocabulary stops being duplicated.
 * The run crew + Oracle values are literally the AgentKind strings, so any drift
 * between the Prisma enum and the catalogue — or between the agent list and the
 * usage list — fails here rather than on the report.
 */
describe('usage catalogue covers the UsageKind enum', () => {
  const enumKinds = Object.values(UsageKind);

  it('has exactly one entry per enum value', () => {
    const catalogueKinds = USAGE_PROFILES.map((p) => p.kind).sort();
    expect(catalogueKinds).toEqual([...enumKinds].sort());
  });

  it('maps every AgentKind onto a usage kind (and back)', () => {
    expect(Object.keys(AGENT_USAGE_KIND).sort()).toEqual([...AGENT_KINDS].sort());
    for (const kind of AGENT_KINDS) {
      expect(AGENT_USAGE_KIND[kind]).toBe(kind);
    }
  });

  it('resolves a label for every usage kind', () => {
    for (const kind of enumKinds) {
      expect(usageProfile(kind).label.length).toBeGreaterThan(0);
    }
  });
});
