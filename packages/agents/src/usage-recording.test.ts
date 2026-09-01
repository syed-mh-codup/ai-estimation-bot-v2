import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import type { IModelProvider } from '@repo/providers';
import { chatJSON, LLMJsonError } from './llm-json';
import { createUsageRecorder } from './usage-recorder';

/**
 * AEH-286: the feature's core claim is that every model call leaves a row saying
 * what it cost. Nothing asserted that. Every other suite stubs the recorder with
 * a `create: vi.fn()` nobody inspects, so the recorder could stop firing —
 * or start writing the wrong kind — and the whole suite would stay green.
 *
 * It matters more since the write became non-throwing: a failed insert is now
 * silent by design, so a test is the only thing that would ever notice.
 */

const schema = z.object({ ok: z.boolean() });

function providerReturning(text: string): IModelProvider {
  return {
    chat: vi.fn().mockResolvedValue({
      text,
      model: 'anthropic/claude-3-haiku',
      usage: { promptTokens: 120, completionTokens: 45, costUsd: 0.00031 },
    }),
    chatStream: vi.fn(),
    embed: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AEH-286: every model call is recorded', () => {
  it('records the call with the served model and real cost', async () => {
    const create = vi.fn();
    const recorder = createUsageRecorder({
      db: { modelUsage: { create } } as never,
      estimateId: 'est-1',
      runId: 'run-9',
    });

    await chatJSON(
      providerReturning('{"ok":true}'),
      { model: 'anthropic/claude-3-opus', messages: [{ role: 'user', content: 'hi' }] },
      schema,
      'Librarian',
      { kind: 'LIBRARIAN', recorder },
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].data).toEqual({
      estimateId: 'est-1',
      runId: 'run-9',
      kind: 'LIBRARIAN',
      // The model as SERVED, not as configured — the request asked for opus.
      model: 'anthropic/claude-3-haiku',
      promptTokens: 120,
      completionTokens: 45,
      costUsd: 0.00031,
    });
  });

  it('records a call whose response then fails to parse', async () => {
    // The billed-but-unusable call is the one most worth counting: it cost real
    // money and produced nothing, and a retry will pay for it again.
    const create = vi.fn();
    const recorder = createUsageRecorder({
      db: { modelUsage: { create } } as never,
      estimateId: 'est-1',
      runId: 'run-9',
    });

    await expect(
      chatJSON(
        providerReturning('not json at all'),
        { model: 'anthropic/claude-3-haiku', messages: [{ role: 'user', content: 'hi' }] },
        schema,
        'Detective',
        { kind: 'DETECTIVE', recorder },
      ),
    ).rejects.toThrow(LLMJsonError);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].data).toMatchObject({
      kind: 'DETECTIVE',
      costUsd: 0.00031,
    });
  });

  it('records a call the provider reported no usage for, as unpriced not free', async () => {
    const create = vi.fn();
    const recorder = createUsageRecorder({
      db: { modelUsage: { create } } as never,
      estimateId: null,
    });
    const provider: IModelProvider = {
      chat: vi.fn().mockResolvedValue({ text: '{"ok":true}', model: 'stub/model', usage: null }),
      chatStream: vi.fn(),
      embed: vi.fn(),
    };

    await chatJSON(
      provider,
      { model: 'stub/model', messages: [{ role: 'user', content: 'hi' }] },
      schema,
      'Architect',
      { kind: 'ARCHITECT', recorder },
    );

    // Null, not zero. A zero would be added up as a real price by every report.
    expect(create.mock.calls[0]![0].data).toMatchObject({
      kind: 'ARCHITECT',
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      runId: null,
      estimateId: null,
    });
  });
});

describe('AEH-286: a costing write never fails the call it is costing', () => {
  it('swallows a database failure and logs it, rather than throwing', async () => {
    // This runs inside a memoised Inngest step, right after a model call that has
    // already been billed. A throw here fails the step, and the retry pays for
    // the same call twice — worse than not counting it.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recorder = createUsageRecorder({
      db: { modelUsage: { create: vi.fn().mockRejectedValue(new Error('neon unreachable')) } } as never,
      estimateId: 'est-1',
      runId: 'run-9',
    });

    await expect(
      recorder.record({
        kind: 'SPECIALIST_DEV',
        model: 'anthropic/claude-3-haiku',
        usage: { promptTokens: 1, completionTokens: 2, costUsd: 0.001 },
      }),
    ).resolves.toBeUndefined();

    // Silent to the pipeline, loud in the log — both halves matter.
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain('SPECIALIST_DEV');
  });

  it('lets a parse failure through even when the usage write fails', async () => {
    // The recorder must not convert an LLMJsonError into a usage error, or the
    // agent's real failure gets masked by the accounting.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const recorder = createUsageRecorder({
      db: { modelUsage: { create: vi.fn().mockRejectedValue(new Error('neon unreachable')) } } as never,
      estimateId: 'est-1',
    });

    await expect(
      chatJSON(
        providerReturning('not json at all'),
        { model: 'anthropic/claude-3-haiku', messages: [{ role: 'user', content: 'hi' }] },
        schema,
        'Librarian',
        { kind: 'LIBRARIAN', recorder },
      ),
    ).rejects.toThrow(LLMJsonError);
  });
});
