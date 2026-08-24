## Jira Integration (single source of truth — no worklog.md, no index.md)

- Space key: AEH
- Board ID: 2342
- Epic: AEH-6
- Project type: company-managed
- Statuses: Backlog, Selected for Development, In Progress, Done
- No "Won't Do" resolution exists — cancelled work uses status Done +
  "cancelled" label (see below)

### Backlog query (always fetch live state, never assume from memory)
project = AEH AND "Epic Link" = AEH-6 ORDER BY priority DESC, status ASC

### Priority mapping
- P0 -> Highest
- P1 -> High
- P2 -> Medium
- P3 -> Low

### Link conventions
- "Blocks" / "is blocked by" for hard sequencing dependencies
- "Relates to" for soft references

### Two distinct workflows
1. **Intake** (skill: add): new idea discussed conversationally, grilled
   via grill-me, checked against existing backlog for duplicates/overlap,
   then created directly in Jira. Ad hoc, not tied to a review cycle.
2. **Grooming** (/groom): periodic review of the existing backlog —
   reprioritize, re-link, transition stale items, mark cancelled work.

### Status changes (either workflow)
Transition Jira issues directly and immediately when status changes are
agreed — confirm exact transition name via jira_get_transitions if unsure.
Cancelled work -> status Done + "cancelled" label
(query with `label != cancelled` to exclude from "actually completed" views)

### progress.md (session continuity only — not a backlog file)
Holds only in-flight session notes: current approach, open questions,
context for resuming next session. Carries no authoritative backlog state —
that's 100% in Jira now.

### Status transitions (transition IDs, not just names)
- 11 -> Backlog
- 21 -> Selected for Development
- 31 -> In Progress
- 41 -> Done

Use these transition IDs directly when moving an issue between statuses.
Only fall back to jira_get_transitions if a transition fails (e.g. issue
is in an unexpected state and one of these IDs isn't a valid option from
its current status).
