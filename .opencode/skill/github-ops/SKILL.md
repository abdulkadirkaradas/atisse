---
name: github-ops
description: Managing GitHub issues, PRs, reviews, labels, and releases through the `gh` CLI. Load when triaging issues, opening or progressing a PR on GitHub itself (not just committing locally), responding to review feedback, or doing anything with `gh`.
license: MIT
compatibility: opencode
---

# GitHub ops

## Preflight — required before anything else in this skill, every time

Before running any `gh` command below, verify both:

1. **Installed:** `gh --version` (or `command -v gh`) succeeds.
2. **Authenticated:** `gh auth status` succeeds and reports a valid, logged-in session for
   the target host.

**If either check fails, refuse the request — don't attempt the task at all, not even the
autonomous-tier commands.** State plainly which condition failed (`gh` isn't installed /
`gh` is installed but not authenticated) and what fixes it (install it; run 'gh auth
login'), then stop. Never install `gh`, run `gh auth login`, or otherwise try to fix it
yourself — `gh auth login` is interactive and a credential change is outside this skill's
authority regardless. Never fall back to the raw GitHub API, a scraped web request, or any
other workaround to route around a missing/unauthenticated CLI — that's the same violation
as skipping the check entirely.

One check at the start of a `github-ops` task is enough for that task — re-verify mid-task
only if a `gh` call unexpectedly fails with an auth-shaped error, which means the earlier
check no longer reflects reality.

Scope split from `git-workflow`: that skill is the local/content side (branch names, commit
shape, what a PR description must contain, release versioning); this one is the _GitHub-side_
lifecycle — the actual `gh` commands that create, move, and close things. Read both when
opening a PR: `git-workflow` says how to shape it, this skill says how to push it through.

## Autonomous — do without asking

`gh issue create/comment/edit/label/view/list` · `gh pr create` (draft or ready) ·
`gh pr comment` · `gh pr review --comment` / `--request-changes` · `gh pr ready` ·
`gh pr view/list/diff/checks` · assigning, labeling, and linking issues/PRs · requesting
reviewers. These are reversible and don't commit the project to anything — do them as part
of normal task execution, no need to narrate the intent to ask first.

## Escalate — stop and get explicit user go-ahead before running

- **Merging a PR** (`gh pr merge`) — even with all checks green and an SPSA approval on
  record. "Approved to merge" and "merged" are different steps; this skill only ever
  executes the second with the user's go-ahead in that moment.
- **Closing an issue or PR** (`gh issue close`, `gh pr close`) unless the task explicitly
  instructed closing it.
- **Approving a review** (`gh pr review --approve`) — a comment or changes-requested review
  is fine autonomously; an approval is a judgment call reserved for the user, or for SPSA
  acting within its own PR-approval authority (see the `spsa` agent profile) — never SPBED
  or SPQAE.
- **Cutting a release** (`gh release create`) — ties to the SemVer/versioning rules in
  `git-workflow`.
- Any repo-settings change: branch protection, secrets, webhooks, visibility, deleting
  anything (`gh repo delete`, `gh secret set`, `gh api` calls that mutate settings).

`opencode.json` encodes the boundary: the escalate-tier commands are `ask` for the
subagents (a real confirmation prompt, not just a documented convention), `gh repo delete`
and secret mutation are `deny` outright — no legitimate agentic use case for either. A
declined confirmation is a Hard Stop, same as any other: stop, don't retry with a
workaround (`gh api` as an escape hatch around a denied `gh pr merge` is the same violation
as the command itself).

## Issue triage

Use whatever label taxonomy the repo already has — don't invent new labels or a new
scheme without asking; a growing, inconsistent label set is worse than none. If the repo
has no labels yet, that's worth surfacing to the user rather than deciding one unilaterally.

## PR lifecycle

1. Push the branch, then `gh pr create` using the `git-workflow` PR template for the body.
2. Address review feedback with follow-up commits per `git-workflow`'s commit rules — don't
   force-push over review history unless the task or reviewer explicitly asked for a
   rewrite.
3. Checks green + approval on record still isn't "go" — the merge itself waits for the
   user, per the escalation rule above.

## Between roles

SPBED is the primary actor here — opens issues/PRs, responds to feedback, keeps them
moving. SPSA's PR-approval authority (its own profile) is the gate _before_ a merge is
even requested from the user. SPQAE may comment with findings but never labels something
"approved" or closes anything — that's outside its authority in every skill, not just this
one.
