# AI Estimation Agent — Agent Specs

Each agent is a Mastra agent whose **system prompt is loaded from the DB** (active
`PromptVersion` for its `AgentKind`) and whose **model string is also from that version**
(swappable via OpenRouter). All inputs/outputs are **Zod-validated structured objects** —
this is what keeps the pipeline deterministic. The prompt bodies below are *seed v1*; admins
edit them later in the UI.

> Convention: every agent runs at temperature 0 (or framework minimum). Every agent returns
> JSON matching its output schema; on parse failure the supervisor retries once then fails the
> step with a typed error.

---

## Supervisor
**Role:** orchestrates the council, manages shared estimate state, enforces the validation
gate, handles caching and refinement routing.
**In:** `{ estimateId, sowText, mode: "full" | "refine", changedMenuItemIds? }`
**Out:** `{ estimateId, status }` (writes everything to `Estimate.agentState`).
**Logic:** normalise + hash SOW → cache lookup → run agents in lifecycle order
(§12 of architecture) → on `refine`, re-run only affected menu items + downstream math.
*Seed prompt:* "You coordinate a council of estimation agents. Never invent effort numbers
yourself; delegate to specialists. Enforce that Detective findings are reconciled against
Specialist buffers before the Architect synthesises. Prefer cached results for identical SOW
hashes."

## Librarian (Parser)
**Role:** map SOW requirements to **versioned Taxonomy IDs**; consistent labelling across runs.
Uses **RAG** over the taxonomy + preset corpus.
**In:** `{ sowText, taxonomyVersionPin }`
**Out:** `{ requirements: [{ text, taxonomyKey, confidence }] }`
*Seed prompt:* "Decompose the SOW into discrete requirements. For each, assign the single best
Taxonomy ID from the provided taxonomy. If none fits well, flag `taxonomyKey:null` with a
suggested new label. Be consistent: identical requirements must always receive the same ID."

## Detective (Researcher)
**Role:** validate API capabilities, rate limits, technical constraints via **web search** and
**admin-connected MCP servers**; surface technical risks (middleware, retries).
**In:** `{ requirements, enabledMcpTools, searchTool }`
**Out:** `{ findings: [{ taxonomyKey, claim, source, riskFlags[] }] }`
*Seed prompt:* "For each requirement that touches an external platform/API, verify capabilities
and constraints (rate limits, auth model, missing endpoints, need for middleware or retry
logic). Cite the source (search result or MCP tool). Emit explicit risk flags the Specialists
and Validation Audit will consume. Do not estimate effort."

## Archivist (Matcher)
**Role:** **pgvector** similarity search of historical presets keyed by Taxonomy IDs.
**In:** `{ requirements }`
**Out:** `{ matches: [{ taxonomyKey, presetId, presetVersion, score, beHours, feHours, risk, aiAssist }] }`
**Logic:** embed each requirement → ANN query (`embedding <=> $q`) → return top-k with scores.
*No LLM call required for the search itself; an optional LLM pass can re-rank.*

## Specialist Council — Dev / QA / PM / BA
Four sub-agents. Each produces an **independent role line item** per menu item.
**Shared in:** `{ menuItem, archivistMatch, detectiveFindings, complexityScore }`
**Out (per role):** `{ role, baseHours, rationale, assumptions[] }`

- **Dev:** anchors on the matched preset's BE+FE, adjusts for complexity score + Detective risk
  flags (e.g. middleware/retries discovered → add hours), applies AI-assist compression.
- **QA:** derives test effort from Dev scope + risk; the QA **regression/bug buffer** % is
  applied later by the taxation engine, so QA here estimates *direct* test design/execution.
- **PM:** coordination/planning effort for the item; **communication tax** % applied later.
- **BA:** requirements/analysis/acceptance-criteria effort; **communication tax** % applied later.

*Seed prompt (per role) parameterised by role description.* "Estimate only your role's effort
for this single menu item. Anchor on the historical match. Justify deviations with the
complexity score and Detective findings. Output hours + rationale + any assumptions that, if
false, change the number."

## Complexity Scorecard (engine, not an LLM)
Deterministic function from `EstimationConfig.complexityRules`:
**In:** `{ requirements, detectiveFindings }` → counts (APIs/integrations, legacy keywords,
data volume). **Out:** `{ score: 1..5, perItemMultipliers }`. Starter heuristics: legacy ~4,
integrations ~3–4, AI work ~3–5, simple web ~1–3.

## Operational Taxation + Infrastructure Baseline (engine)
Applies `EstimationConfig` percentages and baseline hours to role line items:
`taxedHours = baseHours * (1 + tax%)`; injects mandatory infra-baseline line items
(env setup, CI/CD, deployment hypercare) per role.

## Hidden-Work Audit + Validation Audit (engine + LLM check)
- **Hidden-Work Audit:** scans Detective findings + matches for unmodelled work
  (middleware, retries, data remediation) and ensures a line exists for each.
- **Validation Audit (final gate):** cross-checks Detective risk flags against Specialist
  buffers — e.g. a discovered rate limit must be reflected in Dev/QA hours. Emits
  `{ passed, unreconciled[] }`; supervisor blocks the Architect until reconciled or
  acknowledged.

## Architect (Synthesis)
**Role:** compile the **Execution Narrative Array**, the **Deterministic Assumption Set**, and
assemble the **Menu Card** with parent/child dependency mapping.
**In:** full reconciled state. **Out:** `{ narrative[], assumptions[], menuItems[] }`.
*Seed prompt:* "Produce an array of concise approach sentences (one per major menu item),
a deduplicated assumption set drawn from specialist outputs, and the assembled Menu Card.
Preserve preset `requires`/`blocks` as parent/child links. Do not alter specialist hours."
