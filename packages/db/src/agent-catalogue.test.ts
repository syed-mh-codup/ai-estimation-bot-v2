import { describe, expect, it } from 'vitest';
import { AgentKind } from './generated/client/index.js';
import { AGENT_CATALOGUE, AGENT_KINDS, agentProfile, agentsByTrack, isAgentKind } from './agent-catalogue';
import { SEED_PROMPTS } from './seed-prompts';

/**
 * The point of the catalogue is that the agent list stops being duplicated. That
 * only holds while these pass — before it existed the list lived in the Prisma
 * enum, the seed, and two admin pages, and nothing noticed when they diverged.
 *
 * Written against the enum object generated from schema.prisma, so adding a
 * value there and forgetting everything else fails here rather than at runtime
 * on an admin page.
 */
describe('agent catalogue covers the AgentKind enum', () => {
  const enumKinds = Object.values(AgentKind);

  it('has exactly one entry per enum value', () => {
    expect([...AGENT_KINDS].sort()).toEqual([...enumKinds].sort());
  });

  it('has no duplicate entries', () => {
    expect(new Set(AGENT_KINDS).size).toBe(AGENT_CATALOGUE.length);
  });

  it('resolves a profile for every kind', () => {
    for (const kind of enumKinds) expect(agentProfile(kind).kind).toBe(kind);
  });

  it('groups every agent into exactly one track', () => {
    const grouped = agentsByTrack().flatMap((g) => g.agents);
    expect(grouped).toHaveLength(AGENT_CATALOGUE.length);
  });

  it('guards unknown strings', () => {
    expect(isAgentKind('LIBRARIAN')).toBe(true);
    expect(isAgentKind('ORACLE')).toBe(true);
    expect(isAgentKind('WIZARD')).toBe(false);
  });
});

describe('every agent has usable description text', () => {
  // The three lengths render in three different places. An empty one is a blank
  // cell on an admin screen, which is exactly the state this work replaced.
  it.each(AGENT_CATALOGUE)('$kind is described', (agent) => {
    expect(agent.label.length).toBeGreaterThan(0);
    expect(agent.blurb.length).toBeGreaterThan(20);
    expect(agent.summary.length).toBeGreaterThan(agent.blurb.length);
    expect(agent.detail.length).toBeGreaterThan(agent.summary.length);
    expect(agent.consumes.length).toBeGreaterThan(0);
    expect(agent.produces.length).toBeGreaterThan(0);
  });
});

describe('seed prompts and the catalogue agree', () => {
  it('seeds exactly the catalogue set', () => {
    expect([...SEED_PROMPTS.map((p) => p.kind)].sort()).toEqual([...AGENT_KINDS].sort());
  });

  it('gives every prompt a non-empty body and model', () => {
    for (const p of SEED_PROMPTS) {
      expect(p.body.trim().length).toBeGreaterThan(0);
      expect(p.modelString).toMatch(/^[a-z0-9-]+\/[a-zA-Z0-9._-]+$/);
    }
  });

  it("seeds Oracle on its own model, not the council's", () => {
    const oracle = SEED_PROMPTS.find((p) => p.kind === 'ORACLE');
    const librarian = SEED_PROMPTS.find((p) => p.kind === 'LIBRARIAN');
    expect(oracle?.modelString).not.toBe(librarian?.modelString);
  });

  it('states the refusal contract in the Oracle body', () => {
    // The refusal discipline is the feature. If a prompt edit strips it, the
    // agent silently becomes a plausible-sounding guesser, which is the single
    // worst failure mode this surface has.
    const body = SEED_PROMPTS.find((p) => p.kind === 'ORACLE')?.body ?? '';
    expect(body).toMatch(/does not answer the question/i);
    expect(body).toMatch(/do not guess/i);
    expect(body).toMatch(/quote/i);
  });
});
