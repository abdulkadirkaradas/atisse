---
name: handoff-protocol
description: JSON handoff-package schema and routing rules used when SPSA, SPBED, or SPQAE close a task and route to another role or to the user. Load when producing or consuming a handoff, or when deciding whether a task should escalate to USER.
license: MIT
compatibility: opencode
---

# Handoff Protocol

Every task closed by a role agent (SPSA / SPBED / SPQAE) that routes elsewhere ends with a
prose summary followed by a fenced `handoff` block. The JSON is authoritative; the prose is
for the human reading along.

## Schema

```handoff
{
  "schema_version": "1.0",
  "task_id":        "<uuid-v4, generated once, never regenerated across handoffs>",
  "task_label":     "<PROFILE>-<kebab-case-slug-max-5-words>-<4-digit-int>",
  "source":         "SPSA | SPBED | SPQAE",
  "destination":    "SPSA | SPBED | SPQAE | USER",
  "routing_reason": "<ACTION>.<DOMAIN>",
  "iteration":      "<int, starts at 1, +1 per handoff>",
  "status":         "completed | flagged | approved | rejected | needs_review",
  "artifacts":      ["<repo-relative paths; [] is valid>"],
  "flags":          ["<one sentence per open issue; required non-empty if ACTION is REVIEW_REQUIRED or REVISION_REQUIRED>"],
  "required_action": "<one sentence, starts with a verb>",
  "context_summary": "<what the destination needs to know to proceed>",
  "created_at":     "<ISO 8601 UTC, generated fresh — never copied from a prior handoff>"
}
```

`ACTION` ∈ `REVIEW_REQUIRED | REVISION_REQUIRED | ESCALATION | APPROVED | REJECTED`.
`DOMAIN` ∈ `CONTRACT | SECURITY | ARCHITECTURE | TEST_QUALITY | SCOPE | RELEASE | ITERATION_LIMIT`.

## Iteration limit — not discretionary

When `iteration` reaches 4, override `destination` to `USER` and `routing_reason` to
`ESCALATION.ITERATION_LIMIT` regardless of the original routing intent. Check this before
every outgoing handoff, not just when it feels stuck.

## Routing authority matrix

| Source | May route to | Condition                             |
| ------ | ------------ | ------------------------------------- |
| SPBED  | SPSA         | Hard Stop triggered, or task complete |
| SPBED  | USER         | `ESCALATION.ITERATION_LIMIT` only     |
| SPSA   | SPBED        | Revision required                     |
| SPSA   | SPQAE        | Test review required                  |
| SPSA   | USER         | Approval needed, or iteration limit   |
| SPQAE  | SPBED        | Test revision required                |
| SPQAE  | SPSA         | Architectural signal or standard gap  |
| SPQAE  | USER         | `ESCALATION.ITERATION_LIMIT` only     |

Any destination not listed for a source is forbidden — don't improvise a route that isn't
in this table, even if it seems logical for the situation.

## Persistence

Before the handoff prose, call the `save_handoff` MCP tool with `handoff_json` (the object
above, as a string) and `conversation_md`. It writes both files under
`.opencode/handoffs/[task_label]/`. If the call fails, note the error in `flags` and still
emit the prose handoff — don't block on tooling failure.
