# AI Estimation Agent — Architecture

## 1. One-paragraph summary

A SOW (or change request) is uploaded through a Next.js web app. A **Mastra supervisor**
orchestrates a council of agents that turn the unstructured document into a **modular "Menu
Card" estimate**: the **Librarian** maps requirements to versioned **Taxonomy IDs**; the
**Detective** validates technical constraints using a web-search tool and any admin-connected
**MCP servers**; the **Archivist** runs **pgvector** similarity search over the historical
preset library to find the closest known work; the **Specialist Council** (Dev/QA/PM/BA)
computes per-role effort; the **Complexity** and **Hidden-Work** engines apply global
multipliers, operational taxes, and infrastructure baselines; the **Architect** synthesises
the technical narrative, the deterministic assumption set, and assembles the Menu Card with
parent/child dependency mapping. Results are written to **Google Sheets** (one tab per role +
roll-up), are **tweakable in the UI** with state-aware refinement, and each finalised estimate
is **written back into the same versioned database** to grow the historical corpus.

## 2. Monorepo layout (pnpm workspaces)

```
/apps
  /web            Next.js (App Router) — UI, auth, API route handlers
/packages
  /db             Prisma schema, client, migrations, seed (xlsx importer)
  /agents         Mastra: supervisor, agents, tools, prompts loader, eval harness
  /core           Domain logic: complexity, taxation, baseline, menu-card assembly, versioning
  /providers      Swappable adapters: model router (OpenRouter), embeddings, web search, MCP, Sheets
  /shared         Zod schemas + TypeScript types shared across packages
/docs             These files
```

Everything that can be swapped lives in `/packages/providers` behind an interface, so model,
embedding, search, and MCP choices are localized.

## 3. Roles & RBAC

Two roles, enforced at the API layer and in the UI:

- **Estimator** — upload SOWs, run estimates, view/tweak Menu Cards, export to Sheets,
  finalise (which writes back to the DB).
- **Admin** — everything Estimator can do, **plus**: manage users, connect/test **MCP
  servers**, edit **prompts** (versioned), edit **presets & taxonomy** (versioned), and tune
  the **complexity / taxation / baseline config** (versioned).

Auth: email + password (Auth.js / NextAuth credentials provider) with a `role` claim; sessions
in Postgres. Keep it minimal — single-tenant assumed.

## 4. Model routing (swappable via OpenRouter)

A `ModelProvider` wraps Mastra's model router. Models are referenced by string
(`openrouter/<vendor>/<model>`), set per-agent in versioned config, so you can move the
Architect to a stronger model and the Librarian to a cheaper one without code changes.
Embeddings go through the same provider (`embed()`), also swappable. A fallback model can be
configured for outages.

## 5. MCP connector subsystem (your generic requirement)

Not Shopify-specific. A `McpConnector` registry table stores admin-added servers
(name, transport, URL/command, auth secret ref, enabled flag). At agent-build time the
`McpProvider` instantiates a Mastra MCP **client** per enabled server and exposes their tools
to the **Detective** (and optionally other agents). Admin UI supports **add → test
connection → enable/disable**. Secrets are stored encrypted; never in prompts or source.
Shopify MCP becomes just "one server an admin adds."

## 6. Web search

A `SearchProvider` interface (`search(query) -> results[]`) with one default adapter shipped.
Swappable later. The Detective calls it as a Mastra tool. Adapter selection is config-driven.

## 7. Versioning model (canonical record of "what changed and when")

A single, reusable pattern applied to **presets, taxonomy, prompts, and config**:

- Each versioned entity has a stable **logical key** and many **immutable versions**
  (`version` integer, `createdAt`, `createdBy`, `changeReason`, `changeMotivation`
  enum: `upskill | tech-advancement | new-process | post-delivery-validation | correction |
  other`, and the full payload snapshot).
- Exactly one version per key is **active** at a time (or pinned per estimate — see below).
- A **`ChangeLog`** view aggregates all version events for an at-a-glance audit timeline.
- **Estimates pin the versions they used** (taxonomy version, preset versions, prompt
  versions, config version) so an old estimate is always reproducible even after the library
  evolves. This is what makes the system's "deterministic consistency" claim true over time.

## 8. Determinism & caching (SOW hashing)

- The normalised SOW text is hashed (`sha256`). The hash + the set of pinned versions +
  model config form a **cache key**. Identical inputs return the cached estimate — same input,
  same output, every run.
- Agent calls use temperature 0 (or near) and structured (Zod-validated) outputs to minimise
  drift. The eval harness (WS27) asserts that re-running a fixed SOW yields a stable Menu Card.

## 9. The Menu Card & per-role WBS (your modular requirement)

A finalised estimate is a set of **menu items** (one per matched preset/taxonomy node). Each
menu item carries **four independent role line-items** — Dev, QA, PM, BA — with their own
hours and notes. The "same menu items across roles, different line items per role" rule means
toggling a menu item in/out of the project adds/removes the corresponding line in *every*
role's WBS at once, but each role's hours for that item are computed independently. Export
produces one Google Sheet tab per role plus a roll-up — letting customers add/remove items to
optimise cost.

## 10. State-aware refinement

Each estimate persists its full intermediate state (agent outputs per menu item). A tweak to
one module (e.g. "drop B2B cart logic", "bump complexity on the redirect service") re-runs
**only** the affected menu items and downstream taxation/baseline math, not the whole pipeline.
Refinements are recorded as estimate revisions.

## 11. Write-back loop

On **Finalise**, the estimate's menu items can be promoted into the preset/historical tables
as **new versioned rows** (with provenance pointing back to the estimate), so the corpus the
Archivist searches grows automatically. Post-delivery actuals can later be logged against the
same rows (`changeMotivation = post-delivery-validation`) to keep estimates honest.

## 12. Request lifecycle (happy path)

`Upload SOW` → normalise + hash → cache check → **Librarian** (taxonomy mapping) →
**Complexity Scorecard** → **Detective** (search + MCP) ∥ **Archivist** (vector match) →
**Specialist Council** (Dev/QA/PM/BA effort) → **Operational Taxation** + **Infrastructure
Baseline** → **Hidden-Work Audit** → **Validation Audit** (cross-check Detective findings vs
Specialist buffers) → **Architect** (narrative array + assumption set + Menu Card assembly) →
persist + **Google Sheet** → UI review/tweak loop → **Finalise** → write-back.
