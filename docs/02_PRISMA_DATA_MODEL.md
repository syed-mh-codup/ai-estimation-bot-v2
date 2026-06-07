# AI Estimation Agent — Data Model & Seeding

This is the **target shape**, not final SQL. Claude Code should treat it as the spec for the
Prisma schema and refine types/indexes as it implements. The preset fields mirror the columns
in `preset_library_v2.xlsx` exactly so the seed importer is a 1:1 map.

## 1. Conventions

- Postgres 16 + **pgvector**. The `embedding` column uses `vector(N)`; in Prisma it is an
  `Unsupported("vector(1536)")` field, and ANN search is done with raw SQL
  (`ORDER BY embedding <=> $1 LIMIT k`). Adjust `N` to the embedding model's dimension.
- **Versioning pattern:** logical entity + immutable versions; estimates pin versions.
- All money/effort numbers are hours (`Float`), never hardcoded multipliers — config-driven.

## 2. Identity & access

```prisma
enum Role { ADMIN ESTIMATOR }

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  hash      String
  name      String?
  role      Role     @default(ESTIMATOR)
  createdAt DateTime @default(now())
  estimates Estimate[]
}
```

## 3. Taxonomy (versioned, canonical)

Derived initially from the library's `Category` + `Req. type` + `Keywords`, but its own
first-class, versioned tree so it can evolve independently.

```prisma
model TaxonomyNode {
  id          String  @id @default(cuid())
  key         String  @unique          // stable slug, e.g. "b2b.checkout.buyer-identity"
  label       String
  parentKey   String?
  versions    TaxonomyNodeVersion[]
}
model TaxonomyNodeVersion {
  id            String   @id @default(cuid())
  nodeKey       String
  node          TaxonomyNode @relation(fields: [nodeKey], references: [key])
  version       Int
  label         String
  reqType       String?
  keywords      String[]
  active        Boolean  @default(false)
  changeReason  String?
  changeMotivation ChangeMotivation @default(OTHER)
  createdAt     DateTime @default(now())
  createdBy     String?
  @@unique([nodeKey, version])
}
enum ChangeMotivation { UPSKILL TECH_ADVANCEMENT NEW_PROCESS POST_DELIVERY_VALIDATION CORRECTION OTHER }
```

## 4. Preset library (historical corpus — seeded from the xlsx)

One `Preset` (logical) + immutable `PresetVersion`s. Fields map 1:1 to the spreadsheet.

```prisma
model Preset {
  id        String @id            // "P01".."P99" — the spreadsheet ID is the logical key
  versions  PresetVersion[]
}
model PresetVersion {
  id              String   @id @default(cuid())
  presetId        String
  preset          Preset   @relation(fields: [presetId], references: [id])
  version         Int
  active          Boolean  @default(false)

  // --- columns mirrored from preset_library_v2.xlsx ---
  category        String          // Shopify/Ecommerce | B2B | CMS & Content | Integration/Celigo | PIM & Search | Dev Environment
  name            String          // Preset Name (<=60 chars, no client names)
  description     String
  beHours         Int             // BE (h)  — dev backend baseline
  feHours         Int             // FE (h)  — dev frontend baseline
  platforms       String[]        // Shopify|Celigo|Contentful|Klevu|P21|Act-On|Vercel|PIM
  reqType         String          // functional category (matches TaxonomyNode.reqType)
  keywords        String[]
  userStoryTags   String[]        // B2B buyer | Dev ops | Marketing editor
  projectSizeFit  String[]        // SMB | Mid-market | Enterprise
  integrationCount Int            // 1..5
  dataVolume      DataVolume      // NONE | LOW | HIGH
  phase           PresetPhase     // FOUNDATION | CORE | ENHANCEMENT
  requires        String[]        // preset IDs (dependency graph -> parent/child mapping)
  blocks          String[]        // preset IDs
  canParallel     Boolean
  aiAssist        Level           // LOW | MEDIUM | HIGH (effort compression from AI tooling)
  risk            Level           // LOW | MEDIUM | HIGH
  spikeNeeded     Boolean
  notes           String          // key assumption; if violated -> change request

  taxonomyKey     String?         // link into the taxonomy tree
  embedding       Unsupported("vector(1536)")?   // for Archivist similarity search

  changeReason     String?
  changeMotivation ChangeMotivation @default(OTHER)
  createdAt        DateTime @default(now())
  createdBy        String?
  sourceEstimateId String?        // set when this row was promoted from a finalised estimate (write-back)
  @@unique([presetId, version])
}
enum DataVolume { NONE LOW HIGH }
enum PresetPhase { FOUNDATION CORE ENHANCEMENT }
enum Level { LOW MEDIUM HIGH }
```

## 5. Prompts (editable + versioned, per agent)

```prisma
enum AgentKind { SUPERVISOR LIBRARIAN DETECTIVE ARCHIVIST SPECIALIST_DEV SPECIALIST_QA SPECIALIST_PM SPECIALIST_BA ARCHITECT }

model Prompt { kind AgentKind @id  versions PromptVersion[] }
model PromptVersion {
  id            String   @id @default(cuid())
  kind          AgentKind
  prompt        Prompt   @relation(fields: [kind], references: [kind])
  version       Int
  body          String   // the system/instruction text, editable from admin UI
  modelString   String   // e.g. "openrouter/anthropic/claude-..." — per-agent model, swappable
  active        Boolean  @default(false)
  changeReason  String?
  changeMotivation ChangeMotivation @default(OTHER)
  createdAt     DateTime @default(now())
  createdBy     String?
  @@unique([kind, version])
}
```

## 6. Tunable config (complexity / taxation / baseline — versioned, never hardcoded)

```prisma
model EstimationConfig {
  id        String   @id @default(cuid())
  version   Int      @unique
  active    Boolean  @default(false)
  // Complexity scorecard rubric (1..5). Starter heuristics, no hard rules yet:
  // legacy ~4, integrations ~3-4, AI work ~3-5, simple web ~1-3.
  complexityRules Json   // thresholds for apiCount, legacyKeywords, dataVolume -> score & global multiplier
  // Operational taxation (percentages applied per role):
  pmCommunicationTaxPct Float   // PM "communication tax"
  baCommunicationTaxPct Float   // BA "communication tax"
  qaRegressionBufferPct Float   // QA "regression/bug buffer"
  // Infrastructure baseline (mandatory non-feature hours):
  infraBaseline Json   // { envSetup, cicd, deploymentHypercare } per role
  changeReason  String?
  changeMotivation ChangeMotivation @default(OTHER)
  createdAt DateTime @default(now())
}
```

## 7. MCP connectors (admin-managed)

```prisma
model McpConnector {
  id         String   @id @default(cuid())
  name       String
  transport  String   // "http" | "stdio"
  endpoint   String   // URL or command
  authRef    String?  // reference to encrypted secret, never the secret itself
  enabled    Boolean  @default(false)
  lastTestOk Boolean?
  createdAt  DateTime @default(now())
}
```

## 8. Estimates, menu items, per-role line items, refinement state

```prisma
model Estimate {
  id            String   @id @default(cuid())
  title         String
  sowText       String
  sowHash       String           // sha256 of normalised SOW (cache key component)
  status        EstimateStatus @default(DRAFT)   // DRAFT | REVIEW | FINALISED
  complexityScore Int?           // 1..5 overall
  // pinned versions for reproducibility:
  taxonomyVersionsPinned Json
  configVersion Int
  promptVersionsPinned   Json
  modelConfig   Json
  narrative     String[]         // "Execution Narrative Array" (array of approach sentences)
  assumptions   String[]         // "Deterministic Assumption Set"
  agentState    Json             // full intermediate state for state-aware refinement
  ownerId       String
  owner         User     @relation(fields: [ownerId], references: [id])
  menuItems     MenuItem[]
  sheetUrl      String?
  createdAt     DateTime @default(now())
  @@index([sowHash])
}
enum EstimateStatus { DRAFT REVIEW FINALISED }

model MenuItem {
  id           String   @id @default(cuid())
  estimateId   String
  estimate     Estimate @relation(fields: [estimateId], references: [id])
  taxonomyKey  String
  sourcePresetId String?          // matched preset (Archivist)
  matchScore   Float?             // similarity score
  title        String
  enabled      Boolean  @default(true)   // toggle in/out to optimise cost
  parentItemId String?            // parent/child dependency mapping
  lineItems    RoleLineItem[]     // exactly four: DEV, QA, PM, BA — independent
}

enum RoleKind { DEV QA PM BA }
model RoleLineItem {
  id          String   @id @default(cuid())
  menuItemId  String
  menuItem    MenuItem @relation(fields: [menuItemId], references: [id])
  role        RoleKind
  baseHours   Float              // pre-tax effort for this role
  taxedHours  Float              // after taxation/buffer/baseline applied
  notes       String?
  edited      Boolean  @default(false)   // true if a human tweaked it (state-aware refinement)
  @@unique([menuItemId, role])
}
```

## 9. Change log (audit timeline)

A read model (DB view or query) that unions all `*Version` create events across presets,
taxonomy, prompts, and config into a single chronological feed: *what changed, when, by whom,
why, and the motivation enum.* Surface it in the admin UI.

## 10. Seeding from `preset_library_v2.xlsx`

The `📋 Master Database` sheet has 45 rows (P01–P45). The seed script:

1. Reads the workbook (the importer must tolerate the emoji sheet name `📋 Master Database`).
2. For each preset row → create `Preset(id)` + `PresetVersion(version=1, active=true)`,
   parsing pipe-separated fields (`Platforms`, `Requires`, `Blocks`, etc.) into arrays and
   mapping `None/Low/High`, `Yes/No`, phase, and level enums.
3. Derive initial `TaxonomyNode`s from distinct `Category` + `Req. type` (+ keywords) and
   link each preset to its node.
4. Seed one `EstimationConfig(version=1, active=true)` with starter values (the WBS defines
   placeholders; you tune from the UI later).
5. Seed one `PromptVersion(version=1, active=true)` per `AgentKind` from `03_AGENT_SPECS.md`.
6. Generate embeddings for each preset (name + description + keywords) and store in
   `embedding`. **This is the "seed this data to start" step.** New finalised estimates use
   the same path (write-back) so the corpus grows "on the fly."
