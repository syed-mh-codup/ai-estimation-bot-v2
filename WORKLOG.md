# WORKLOG — feature backlog / ideas not yet started

> Distinct from PROGRESS.md (which tracks live, in-progress work). This file
> captures requested features and ideas that haven't been scoped or started
> yet, so they aren't lost between sessions.

## Steering input for estimates (requested 2026-07-08)

**What:** Let the user supply "steering" guidance on an estimate — specific
instructions on how to plan/execute a particular requirement — instead of
leaving every execution decision entirely up to the LLM. Example: telling the
system "use the existing auth service, don't build a new one" or "this
integration should be a thin polling adapter, not a real-time webhook" for
one specific requirement within a larger BRD.

**Why:** Right now the agents (Librarian → Specialists → Architect) infer
approach entirely from the SOW/BRD text. When the estimator already knows a
constraint or preference the document doesn't state explicitly, there's no
way to feed that in — the only lever is editing the source document itself,
which is often not desirable (the BRD is the client's document, not scratch
space for internal planning notes).

**Key design constraint (explicitly flagged by the requester):** steering
must be scoped and tactful — it must not "derail" or dominate the whole
estimate. A steering note aimed at one requirement should not bleed into how
unrelated requirements are planned. This is the same class of failure this
codebase already hit once: see the estimate-quality-prompt-code-drift memory
and PROGRESS.md's "generalize classification vocabulary" work, where a
strong global signal (the ecommerce preset library baked into every prompt)
skewed classification for everything, not just the cases it legitimately
applied to. Steering input needs to avoid repeating that mistake — it should
be a targeted, bounded signal, not a global system-prompt addition.

**Possible integration point (not committed to, just a starting thought):**
the pipeline already calls SPECIALIST_DEV/QA/PM/BA once per requirement
(`packages/agents/src/specialist.ts` → `buildUserMessage`), so a
per-requirement `steeringNotes` field threaded only into that specific
requirement's specialist call would be naturally scoped — it wouldn't touch
the prompt/context for any other requirement. This would likely mean:
- A new optional field on `Requirement` (`packages/shared/src/schemas.ts`)
  and the corresponding DB column.
- A UI surface for the user to attach steering text to a requirement, most
  naturally after the Librarian has decomposed the SOW (so the user is
  steering an actual identified requirement, not guessing at decomposition
  in advance) — likely a review step between Librarian and the rest of the
  pipeline, which doesn't fully exist yet (today the pipeline runs straight
  through Librarian → Specialists with no pause for human input).
- Explicit instruction to the Specialist prompt that steering is a
  constraint on ONE requirement's execution approach, not a signal about the
  rest of the project — i.e. avoid the same over-generalization failure mode
  as the closed-vocabulary bug.

**Status:** not started. No code changes made. Recorded here per request.
