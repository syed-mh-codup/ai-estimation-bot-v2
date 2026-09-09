import { z } from 'zod';
import type { IModelProvider } from '@repo/providers';

import { chatJSON } from './llm-json';
import { CALL_TIMEOUTS, callTuning, type ModelCallLevers } from './model-call';
import type { UsageRecorder } from './usage-recorder';

/**
 * The Scribe — rewriting the narrative and the assumptions. AEH-238.
 *
 * Runs when somebody ticks some statements and says what is wrong with them. It
 * changes WORDS: it cannot reach an hour, a card or a line item, and not
 * because this prompt asks it not to — the write set is `pinnedStatementIds`
 * and there is nothing else in it.
 *
 * Its own agent kind rather than the Architect's, for the same reason the
 * Curator is not the Architect. The Architect writes a narrative from scratch
 * out of a whole run's specialist output; this is handed existing wording and
 * an instruction about it. Different input, different output shape, and a
 * prompt an admin tunes for one of those jobs would be wrong for the other.
 *
 * ## The two silent failures this guards
 *
 * A ref the model invented, or one pointing at a LOCKED statement. The first
 * would write wording against a statement that was never in the envelope; the
 * second would write against one somebody froze. Both are dropped here rather
 * than at the applier, so the reason can be reported in the notes a person
 * reads. The applier refuses the whole write if a lock is touched — this is the
 * earlier, gentler line of the same defence.
 *
 * ## Deletion, and why it is a legitimate answer
 *
 * "These two assumptions say the same thing" is answered by merging them, which
 * means one statement absorbs the other and the other goes. So an empty string
 * deletes. That is why the model is shown every statement in the list, not just
 * the ticked ones: it cannot merge into a line it cannot see.
 */

const LLMScribeLineSchema = z.object({
  ref: z.number().int().min(1),
  /** Empty deletes this line — see the note on merging. */
  text: z.string(),
});

const LLMScribeSchema = z.object({
  lines: z.array(LLMScribeLineSchema).default([]),
  notes: z.string().optional(),
});

export type ScribeContext = {
  modelProvider: IModelProvider;
  modelString: string;
  /** The admin-authored, versioned SCRIBE prompt body. */
  instructions: string;
  recorder: UsageRecorder;
  levers?: ModelCallLevers | undefined;
};

/** One statement as the Scribe sees it. */
export type ScribableStatement = {
  statementId: string;
  text: string;
  /** In the envelope: the Scribe may return wording for it. */
  inEnvelope: boolean;
  /** Frozen. Shown so the wording fits around it; never writable. */
  locked: boolean;
};

/** One statement's new wording. Empty text means delete it. */
export type ScribedStatement = {
  statementId: string;
  text: string;
};

export type ScribeOutput = {
  /** Only the statements it actually changed, resolved to real ids. */
  lines: ScribedStatement[];
  /** What it says it did, or why it declined. Recorded as the edit's reasoning. */
  notes: string | null;
};

function buildUserMessage(args: {
  kindLabel: string;
  statements: ScribableStatement[];
  instruction: string;
  ledgerContext: string;
}): string {
  const { kindLabel, statements, instruction, ledgerContext } = args;

  // Every statement in the list is numbered, whether or not it is in the
  // envelope, and the numbering is what the refs come back against. A model
  // shown only the ticked lines could not merge one into an untouched
  // neighbour, and could not avoid repeating what a locked line already says.
  const numbered = statements
    .map((s, i) => {
      const marks = [
        s.inEnvelope ? null : 'not selected — cannot be changed',
        s.locked ? 'LOCKED — cannot be changed' : null,
      ].filter((m): m is string => m !== null);
      return `${i + 1}. ${s.text}${marks.length ? `   [${marks.join('; ')}]` : ''}`;
    })
    .join('\n');

  const selectable = statements
    .map((s, i) => (s.inEnvelope && !s.locked ? i + 1 : null))
    .filter((n): n is number => n !== null);

  return `Rewrite part of this estimate's ${kindLabel}.

The full list, numbered:
${numbered}

You may return wording for these numbers only: ${
    selectable.length > 0 ? selectable.join(', ') : 'none'
  }.

The estimator's instruction:

${instruction}

The rest of this estimate, for context. You are not changing any of it — it is here so the wording you write is true of the work that is actually costed:
${ledgerContext}`;
}

/**
 * Rewrite the statements in the envelope, and resolve the answer to real ids.
 *
 * A line the model returns unchanged is dropped rather than written. That is
 * not an optimisation: writing it would restamp a line nobody edited as
 * `STEERED` and bump the `updatedAt` a later edit reads as staleness, so
 * "changed nothing" has to mean nothing.
 */
export async function runScribe(
  args: {
    kindLabel: string;
    statements: ScribableStatement[];
    instruction: string;
    ledgerContext: string;
  },
  ctx: ScribeContext,
): Promise<ScribeOutput> {
  const writable = args.statements.filter((s) => s.inEnvelope && !s.locked);
  if (writable.length === 0) {
    return {
      lines: [],
      notes: 'Nothing to rewrite — every statement in the selection is locked or absent.',
    };
  }

  const parsed = await chatJSON(
    ctx.modelProvider,
    {
      model: ctx.modelString,
      messages: [
        { role: 'system', content: ctx.instructions },
        { role: 'user', content: buildUserMessage(args) },
      ],
      temperature: 0,
      ...callTuning(ctx.levers, CALL_TIMEOUTS.single),
    },
    LLMScribeSchema,
    'Scribe',
    { kind: 'SCRIBE', recorder: ctx.recorder },
  );

  const refused: string[] = [];
  const lines: ScribedStatement[] = [];
  const claimed = new Set<number>();

  for (const line of parsed.lines) {
    const statement = args.statements[line.ref - 1];
    if (!statement) {
      refused.push(`line ${line.ref}, which is not in the list`);
      continue;
    }
    if (claimed.has(line.ref)) continue;
    claimed.add(line.ref);

    if (statement.locked) {
      refused.push(`a locked line ("${truncate(statement.text)}")`);
      continue;
    }
    if (!statement.inEnvelope) {
      refused.push(`a line outside the selection ("${truncate(statement.text)}")`);
      continue;
    }

    const text = line.text.trim();
    // Unchanged wording is not a change. See the note above.
    if (text === statement.text.trim()) continue;
    lines.push({ statementId: statement.statementId, text });
  }

  const notes = [
    parsed.notes?.trim() || null,
    refused.length > 0
      ? `Left alone: the model returned wording for ${refused.join(', ')}, which the envelope does not cover.`
      : null,
  ]
    .filter((n): n is string => n !== null)
    .join(' ');

  return { lines, notes: notes || null };
}

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
