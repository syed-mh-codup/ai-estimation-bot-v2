# AI Estimation Agent — Build Guide (read this first)

This bundle is written to be handed **directly to Claude Code**. It is intentionally
front-loaded so you can stay hands-off during the build. Four documents:

| File | Purpose |
|------|---------|
| `00_BUILD_GUIDE.md` | This file. Conventions, stack decisions, how to drive Claude Code, the 2-day plan. |
| `01_ARCHITECTURE.md` | System design, RBAC, MCP connector subsystem, versioning model, model routing, output. |
| `02_PRISMA_DATA_MODEL.md` | Target schema + seeding strategy. The xlsx import it describes was retired in AEH-242. |
| `03_AGENT_SPECS.md` | Per-agent input/output contracts and editable prompt scaffolds. |
| `04_WBS.md` | The work breakdown structure. ~4h-per-step, dependency-ordered, full-stack + QA. |

---

## 1. Stack decisions (the ones you left to me)

You said: greenfield, fresh monorepo, TypeScript, swappable models via an aggregator
(OpenRouter), Postgres + Prisma, no fixed framework yet, web UI on shadcn/MUI, MCP as a
generic admin-connectable subsystem, Sheets API output, versioned everything, admin +
estimator roles. Given those constraints:

- **Language/runtime:** TypeScript on Node 20+, **pnpm workspaces** monorepo.
- **Agent framework:** **Mastra** (`@mastra/core`). It is TypeScript-native, has a
  **supervisor + specialist agent** pattern out of the box, a **model router with
  OpenRouter gateway support** (swap models with a `provider/model` string — exactly your
  requirement), a **first-class MCP client** (load tools from remote MCP servers at
  runtime — exactly your admin-connectable-MCP requirement), built-in **RAG** (for the
  Librarian) and **evals/scorers** (for your determinism QA). It is built on the Vercel AI
  SDK, so nothing is locked in. *Alternative if you ever want it: LangGraph.js — noted in
  `01_ARCHITECTURE.md`, but Mastra is the recommended default and the WBS assumes it.*
- **Database:** Postgres 16 + **pgvector** for the Archivist's similarity search (one DB,
  no separate vector store). Prisma is the ORM; the `vector` column is reached via Prisma's
  `Unsupported` type + raw SQL for ANN queries (standard pattern, called out in the WBS).
- **Embeddings:** routed through the **same OpenRouter abstraction** as chat models so the
  embedding model is swappable (default: a small, cheap embedding model; configurable).
- **Web search & MCP:** both are **swappable providers** behind a `ToolProvider` interface.
  Web search ships with one default adapter; MCP is a generic registry admins populate.
- **Frontend:** Next.js (App Router) + **shadcn/ui** + Tailwind. "Make it disappear" —
  decent, quiet, fast. No design heroics.
- **Output:** **Google Sheets API** via a service account, one tab per role
  (Dev / QA / PM / BA) plus a roll-up tab.
- **Testing:** **Vitest** (unit/integration), **Playwright** (a thin e2e smoke), and a
  **Mastra eval harness** for determinism/consistency.

If any of these is a dealbreaker, change it here before starting — every WBS task that
depends on a choice names the choice, so swaps are localized.

---

## 2. WBS conventions (how to read `04_WBS.md`)

- **Task ID:** `WS<n>-<seq>` (e.g. `WS4-03`). Stable; dependencies reference these IDs.
- **Size:** every task is scoped to **~4 hours of *human* developer effort** (your unit).
  This is the human-equivalent estimate, *not* Claude Code wall-clock — Claude Code will
  finish most in minutes. The 4h yardstick exists so steps are uniformly small and
  independently verifiable.
- **`depends:`** hard prerequisites (must be green first). Tasks with no unmet dependency
  can run in any order / in parallel.
- **`∥`** marks tasks that are safe to run in parallel with their siblings.
- **DoD (Definition of Done):** every task has explicit, checkable acceptance criteria.
  **Claude Code must satisfy the DoD — including the stated test — before moving on.**
- **`[SLICE]`** marks tasks on the **thin vertical slice** (see §4). Do these first.
- **Role** is `dev` unless marked `qa`. QA is woven in *and* has dedicated hardening
  workstreams (WS25–WS27).

---

## 3. How to drive Claude Code (low-involvement protocol)

1. Drop all five files into the repo root in a `/docs` folder.
2. Kick off with: *"Read `/docs/00_BUILD_GUIDE.md` through `04_WBS.md`. Build in WBS order.
   For each task: implement, satisfy the DoD (write and run the test it names), commit with
   message `WS<n>-<seq>: <title>`, then continue. Stop and ask me only if a DoD cannot be
   met or a decision contradicts the docs."*
3. Standing rules to give Claude Code once:
   - One commit per WBS task. Never skip a task's test.
   - If a real-world API/credential is missing (OpenRouter key, Google service account,
     an MCP server URL), **stub it behind the provider interface, mark the task
     `BLOCKED-CREDENTIAL`, and keep going** — don't stall the build.
   - Keep all tunable numbers (complexity thresholds, taxation %, baseline hours) in
     **seeded config rows**, never hardcoded — you'll tune them later from the UI.
   - All prompts live in the DB as **versioned rows**, never in source. The agents read the
     active prompt version at runtime.

### Credentials to have ready (so nothing blocks)
- OpenRouter API key.
- Postgres connection string (local Docker is in WS0).
- Google Cloud service-account JSON with Sheets API enabled + a destination Drive folder ID.
- At least one MCP server URL to test the connector (any remote MCP server works for the
  smoke test; your real ones can be added from the admin UI later).

---

## 4. The 2-day reality check

A faithful 4h-granular WBS for a multi-agent platform with a web UI is **~130 tasks**. You
do **not** need all of it working in two days — you need a **working end-to-end slice** fast,
then breadth. So the WBS is ordered to deliver a **thin vertical slice** first: upload a
SOW → run a minimal supervisor → match presets → produce a Menu Card → export to Sheets.
Everything tagged **`[SLICE]`** is on that path; build those first and you have a demoable
product early on day 1. Then the remaining workstreams widen it (full agent council, hidden
-work math, versioning UI, refinement, evals) and can run largely in parallel.

Day 1: WS0–WS3 foundation, then the `[SLICE]` tasks across WS8–WS19.
Day 2: full agent council (WS9–WS16), hidden-work framework, refinement, admin UI, QA
hardening (WS25–WS27), deployment baseline (WS28).

---

## 5. Coverage map (spec → workstreams)

Every element of the spec PDF is covered:

- Supervisor-Agent architecture → WS8
- Librarian / Detective / Archivist / Specialist Council / Architect → WS9 / WS10 / WS11 / WS13 / WS16
- Complexity Scorecard (1–5) → WS12
- Operational Taxation (PM/BA comms tax, QA buffers) + Infrastructure Baseline → WS14
- Hidden Work Audit + Validation Audit → WS15
- Phase-1 (multi-role matrices, taxonomy + RAG Librarian, SOW hashing/caching) → WS1, WS6, WS8, WS9
- Phase-2 (MCP + search, complexity engine global multipliers, hidden-work gate) → WS4, WS5, WS10, WS12, WS15
- Phase-3 (Menu Card + dependency/parent-child mapping, state-aware refinement, narrative array) → WS16, WS17, WS18
- Deliverables (standardized WBS, multi-dept breakdown, narrative array, assumption set, modular Menu Card spreadsheet) → WS16, WS17, WS19
- Your additions (admin/estimator RBAC, editable+versioned prompts, generic MCP connector, on-the-fly write-back of new estimates, per-role WBS sharing menu items) → WS2, WS4, WS7, WS17, WS20
