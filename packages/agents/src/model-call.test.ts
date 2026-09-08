import { describe, it, expect, vi } from 'vitest';
import type { ChatOptions, IModelProvider } from '@repo/providers';
import {
  CALL_TIMEOUTS,
  CREW_DEFAULT_LEVERS,
  callTuning,
  toProviderSort,
  toReasoningEffort,
} from './model-call';
import { runLibrarian } from './librarian';
import { runSpecialistCouncil } from './specialist';
import { createUsageRecorder } from './usage-recorder';

/**
 * A provider that records the options it was handed and answers with whatever
 * the caller's schema needs. The point of every test below is the OPTIONS, not
 * the answer — a lever that is set on a version row and then never reaches
 * `chat` is the failure this file exists to catch.
 */
function recordingProvider(text: string): { provider: IModelProvider; calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  const provider: IModelProvider = {
    async chat(options: ChatOptions) {
      calls.push(options);
      return { text, model: 'stub/model', usage: null };
    },
    chatStream() {
      throw new Error('not used');
    },
    async embed() {
      return { vectors: [], model: 'stub/embed', usage: null };
    },
  } as unknown as IModelProvider;
  return { provider, calls };
}

/** A recorder with no database behind it: nothing here asserts on usage rows. */
const noopRecorder = () =>
  createUsageRecorder({
    db: { modelUsage: { create: vi.fn() } } as never,
    estimateId: 'e1',
  });

describe('callTuning', () => {
  it('always carries a timeout', () => {
    expect(callTuning(undefined, 1234).timeoutMs).toBe(1234);
  });

  it('omits both levers when unset, rather than sending undefined', () => {
    const t = callTuning(undefined, 1000);
    // `not.toHaveProperty`, not `toBeUndefined`: OpenRouter's default routing
    // has to stay the default for a caller that never opted in, and a present
    // key with an undefined value is a different wire message from no key.
    expect(t).not.toHaveProperty('reasoning');
    expect(t).not.toHaveProperty('provider');
  });

  it('omits a lever explicitly set to null — null is "leave the default alone"', () => {
    const t = callTuning({ reasoningEffort: null, providerSort: null }, 1000);
    expect(t).not.toHaveProperty('reasoning');
    expect(t).not.toHaveProperty('provider');
  });

  it('passes each lever through in the shape OpenRouter expects', () => {
    const t = callTuning({ reasoningEffort: 'low', providerSort: 'throughput' }, 1000);
    expect(t.reasoning).toEqual({ effort: 'low' });
    expect(t.provider).toEqual({ sort: 'throughput' });
  });

  it('carries one lever without the other', () => {
    expect(callTuning({ reasoningEffort: 'high' }, 1)).not.toHaveProperty('provider');
    expect(callTuning({ providerSort: 'latency' }, 1)).not.toHaveProperty('reasoning');
  });
});

describe('crew defaults', () => {
  it('buys throughput and leaves thinking alone', () => {
    // Measured on 8 September against ~google/gemini-flash-latest: throughput
    // routing is 2.1x on its own and changes nothing about the output, while
    // reasoning=low is a further 2.4x and moved the same requirement from
    // 20-22 line items to 16-19. One is free, the other is a judgment call
    // about the hours, so only the free one is a default.
    expect(CREW_DEFAULT_LEVERS.providerSort).toBe('throughput');
    expect(CREW_DEFAULT_LEVERS.reasoningEffort).toBeNull();
  });
});

describe('call timeouts fit the step ceiling', () => {
  // 300s is the hard per-step ceiling on Vercel Hobby, and ~60s of it has to be
  // left over for the step to record a readable error rather than be killed
  // mid-call. These are the arithmetic AEH-321's timeout comment describes; if
  // withRetry's default attempt count changes, this is the test that fails.
  const CEILING_MS = 300_000;
  const HEADROOM_MS = 60_000;
  const SPECIALIST_ATTEMPTS = 2; // withRetry(step, fn) => maxRetries = 1

  it('leaves error headroom for a single-attempt step', () => {
    expect(CALL_TIMEOUTS.single).toBeLessThanOrEqual(CEILING_MS - HEADROOM_MS);
  });

  it('leaves error headroom for the specialist step across every attempt', () => {
    expect(CALL_TIMEOUTS.retried * SPECIALIST_ATTEMPTS).toBeLessThanOrEqual(
      CEILING_MS - HEADROOM_MS,
    );
  });

  it('keeps the best-effort budget well under the others', () => {
    // The Archivist rerank runs once per requirement inside ONE step, so its
    // budget cannot be sized like a call that owns a step to itself.
    expect(CALL_TIMEOUTS.bestEffort).toBeLessThan(CALL_TIMEOUTS.retried);
  });
});

describe('parsers', () => {
  it('accepts the three efforts and rejects everything else', () => {
    expect(toReasoningEffort('low')).toBe('low');
    expect(toReasoningEffort('medium')).toBe('medium');
    expect(toReasoningEffort('high')).toBe('high');
    expect(toReasoningEffort(null)).toBeNull();
    expect(toReasoningEffort('')).toBeNull();
    // There is no off switch, by measurement: AEH-321 found reasoning
    // explicitly disabled hung for over nine minutes and never returned.
    expect(toReasoningEffort('none')).toBeNull();
    expect(toReasoningEffort('off')).toBeNull();
  });

  it('accepts the three sorts and rejects everything else', () => {
    expect(toProviderSort('throughput')).toBe('throughput');
    expect(toProviderSort('latency')).toBe('latency');
    expect(toProviderSort('price')).toBe('price');
    expect(toProviderSort('cheapest')).toBeNull();
    expect(toProviderSort(undefined)).toBeNull();
  });
});

describe('the levers reach the provider', () => {
  const LIB_ANSWER = JSON.stringify({
    requirements: [
      {
        text: 'A requirement',
        category: 'Web Application',
        reqType: 'Feature',
        platforms: [],
        projectSize: 'SMB',
        dataVolume: 'Low',
        integrationCount: 0,
        candidateMenuCardId: 'MC-WEB-THING',
        taxonomyKey: null,
        sourceRef: 'SOW',
        ambiguities: [],
        blocksEstimation: false,
      },
    ],
  });

  it('the Librarian sends its own levers and a single-attempt timeout', async () => {
    const { provider, calls } = recordingProvider(LIB_ANSWER);
    await runLibrarian('A statement of work', [], {
      modelProvider: provider,
      modelString: 'stub/model',
      instructions: 'be a librarian',
      recorder: noopRecorder(),
      levers: { reasoningEffort: 'medium', providerSort: 'throughput' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.reasoning).toEqual({ effort: 'medium' });
    expect(calls[0]!.provider).toEqual({ sort: 'throughput' });
    expect(calls[0]!.timeoutMs).toBe(CALL_TIMEOUTS.single);
  });

  it('the Librarian sends no lever fields when it has none', async () => {
    const { provider, calls } = recordingProvider(LIB_ANSWER);
    await runLibrarian('A statement of work', [], {
      modelProvider: provider,
      modelString: 'stub/model',
      instructions: 'be a librarian',
      recorder: noopRecorder(),
    });
    expect(calls[0]).not.toHaveProperty('reasoning');
    expect(calls[0]).not.toHaveProperty('provider');
    expect(calls[0]!.timeoutMs).toBe(CALL_TIMEOUTS.single);
  });

  it('each specialist role gets its OWN lever, not the council-wide one', async () => {
    const answer = JSON.stringify({
      lineItems: [
        {
          description: 'do the thing',
          hours: 2,
          complexity: 'base',
          aiAssistApplied: false,
          dependsOn: [],
        },
      ],
      assumptions: [],
      coversRiskFlags: [],
    });
    const { provider, calls } = recordingProvider(answer);

    await runSpecialistCouncil(
      {
        requirement: {
          id: 'REQ-001',
          text: 'A requirement',
          category: 'Web Application',
          reqType: 'Feature',
          platforms: [],
          projectSize: 'SMB',
          dataVolume: 'Low',
          integrationCount: 0,
          candidateMenuCardId: 'MC-WEB-THING',
          taxonomyKey: null,
          sourceRef: 'SOW',
          ambiguities: [],
          blocksEstimation: false,
        },
        menuCardId: 'MC-WEB-THING',
        riskFindings: [],
        complexityScore: 3,
      } as never,
      {
        modelProvider: provider,
        modelString: 'stub/model',
        instructions: { DEV: 'dev', QA: 'qa', PM: 'pm', BA: 'ba' },
        recorder: noopRecorder(),
        // Only DEV is turned down. This is the whole point of keying the levers
        // by role: one context serves four agents that are four prompt rows.
        levers: { DEV: { reasoningEffort: 'low', providerSort: 'throughput' } },
      },
    );

    expect(calls).toHaveLength(4);
    const byRole = new Map(
      calls.map((c) => [String(c.messages[0]?.content), c] as const),
    );
    expect(byRole.get('dev')!.reasoning).toEqual({ effort: 'low' });
    expect(byRole.get('dev')!.provider).toEqual({ sort: 'throughput' });
    for (const role of ['qa', 'pm', 'ba']) {
      expect(byRole.get(role)).not.toHaveProperty('reasoning');
      expect(byRole.get(role)).not.toHaveProperty('provider');
    }
    // Half the single-call budget, because this step is allowed two attempts.
    for (const c of calls) expect(c.timeoutMs).toBe(CALL_TIMEOUTS.retried);
  });
});
