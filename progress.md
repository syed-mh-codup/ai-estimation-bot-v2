# AEH-321 — artifact generation triage (2026-09-04)

## Verdict

Steps ARE separate Inngest invocations. The architecture is fine. Every failure
is one SINGLE step exceeding Vercel's 300s and being killed —
`FUNCTION_INVOCATION_TIMEOUT` — which Inngest reports as
"Your server returned HTTP 504 before the SDK responded."

## Evidence — every artifact run ever (4 of them, from the Inngest API)

| event received | run | ended | outcome |
|---|---|---|---|
| 09-03 12:37:02 | 01M1KMBKJ44KCWNNBRKSWSDEJY | 12:54:53 | 504 FUNCTION_INVOCATION_TIMEOUT (artifact row since deleted) |
| 09-03 13:11:51 | 01M1KPBB3X1K32Z48WZ929ZMNN | 13:22:37 | ZodError: `choices[0].message.content` was null (artifact row since deleted) |
| 09-03 13:42:13 | 01M1KR2YSMY8K430GXVKDS88MM | 14:10:07 | 504 FUNCTION_INVOCATION_TIMEOUT — `cmtlkqvh5…` |
| 09-04 05:05:22 | 01M1NCX9B2C3X6Q15T7GQT682G | 05:25:34 | 504 FUNCTION_INVOCATION_TIMEOUT — `cmtmhq1nf…` (the "ongoing" one; it died at 05:25) |

Proof the steps are separate invocations, not clumped:
- run 01M1KR2Y… spanned 1650s wall clock against a 300s per-invocation ceiling.
- the 13:11 ZodError stack shows Inngest's own one-step-per-request loop:
  `tryExecuteStep -> steps-found -> runCoreLoop -> route.handleAction`.
- section rows landed minutes apart with their own ModelUsage rows.

## Per-step timeline of run `cmtlkqvh5…` (from ModelUsage + ArtifactSection)

- 13:42:37 run starts
- 13:53:22 outline usage recorded (ct 4228)  — 645s from run start
- 13:55:31 section 1 `overview-conventions` (ct **30168**, 21435 chars) — 129s
- 13:58:26 section 2 `identity-tenancy`     (ct **19657**, 17396 chars) — 174s
- 14:10:07 run FAILS — 701s on section 3 `content-generation`, no usage row
  (= 2 attempts x ~300s + backoff; `retries: 1` is per-step)

Same shape for `cmtmhq1nf…`: outline +394s, section 1 (ct 5955) +111s,
then 666s on section 2 and dead.

## Root cause

`SECTION_WORD_BUDGET = 700` appears ONLY in `OUTLINE_ENVELOPE`
(packages/agents/src/artifacts.ts:110). `SECTION_ENVELOPE` — the prompt the
section writer actually receives — never states any size budget, and ends with
"Write the section, in full, to the brief. Do not summarise and do not leave
placeholders for a human to fill in."

So the planner plans 700-word sections and the writer is told the opposite.
Measured: 30,168 and 19,657 completion tokens for sections planned at ~1,000.
20-30x over. That is what pushes a step past 300s.

Contributing:
- the model `~deepseek/deepseek-v4-flash-latest` (serves
  `deepseek/deepseek-v4-flash-0731`) is a REASONING model — a live outline call
  measured 48.8s / 1501 completion tokens of which **1004 were reasoning tokens**.
  Reasoning time is invisible in the recorded `completion_tokens`.
- `fetchRaw` in packages/providers/src/model-provider.ts:327 has NO timeout and
  no AbortSignal. The code cannot fail fast — it runs until Vercel kills the
  process, wasting the full 300s AND the already-paid completion.
- `fetchWithFallback` (line 308) retries on the fallback model, doubling wall
  clock on an error. `OPENROUTER_FALLBACK_MODEL` is unset locally.

## Fix options (not yet implemented)

1. Put the size budget in `SECTION_ENVELOPE` and drop "Do not summarise" —
   the one-line change that addresses the actual cause.
2. `AbortSignal.timeout(~240s)` on the ARTIFACT chat calls so a step fails with
   a real, readable error inside the ceiling instead of a 504.
3. Switch the artifact type's model to a non-reasoning one (admin, no deploy).
