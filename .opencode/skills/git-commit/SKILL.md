---
name: git-commit
description: Analyze workspace diffs, split unrelated changes into atomic commits adhering to SRP and Semantic Conventions, and execute them sequentially when in build mode.
license: MIT
compatibility: opencode
metadata:
  audience: developers
  workflow: git-versioning
---

# Git Commit Skill

Expert guidance for analyzing git diffs, decomposing them into atomic, semantically correct commits, and executing them safely.

---

## Quick Start

### Essential Rules

1. **STRICT INSTRUCTION:** DO NOT MODIFY ANY FILES UNLESS IN BUILD MODE.
2. **Follow SRP:** Split unrelated changes (even within the same file) into separate, independent commits.
3. **CRITICAL:** Prefix every commit message with the correct semantic type (`feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `style`).
4. **CRITICAL:** Append `!` immediately after the type/scope for any breaking changes (e.g., `feat!:`).
5. **Traceability:** Every single commit must explicitly list the absolute file paths it affects.

---

## Mode Selection Guide

This skill operates in two distinct modes. Always identify the active mode before taking action:

### PLAN MODE

**Use this mode when:** `[CURRENT MODE: PLAN MODE]` is stated or implicit.

- **How it works:** Code or workspace analysis executes, but **no** git actions are performed.
- **Output:** Generate the prioritized commit list using the strict format. STOP and wait for verification.

### BUILD MODE

**Use this mode when:** `[CURRENT MODE: BUILD MODE]` is explicitly active.

- **How it works:** The list is generated, and the agent immediately executes `git commit` actions sequentially.
- **Execution:** Do NOT wait for user confirmation between commits.

---

## Commit Type Conventions

Choose the appropriate semantic type based on the nature of the diff:

### Pattern 1: feat & fix - Code Changes
- `feat`: Use when adding a completely new feature or capability.
- `fix`: Use when resolving a bug, error, or broken behavior.
- *Breaking Change Example:* `feat!: breaking change description`

### Pattern 2: refactor & style - Maintenance
- `refactor`: Use for code changes that neither fix a bug nor add a feature (e.g., restructuring).
- `style`: Use for changes that do not affect the meaning of the code (formatting, missing semi-colons, white-space).

### Pattern 3: test, chore & docs - Metadata & Quality
- `test`: Use when adding missing tests or correcting existing tests.
- `chore`: Use for updating build tasks, package configurations, or dependencies.
- `docs`: Use when the changes are strictly limited to documentation (e.g., README updates).

---

## Return & Output Format Requirements

**CRITICAL RULE:** The agent must format the execution plan exactly as specified below. No conversational filler.

### Correct Format Template

```markdown
### [Type]: [Subject]
**Description:** What and why (include breaking changes details if applicable).
**Files:**
- [file_path_1]
- [file_path_2]

```

### Dependency Awareness Rule

Ensure prerequisite commits (e.g., a `refactor` or a `chore` that prepares the codebase) strictly precede and are executed before dependent commits (e.g., the actual `feat`).

---

## Error Prevention - Top 6 Mistakes to Avoid

### #1: Amalgamated Commits (SRP Violation)

* ❌ **WRONG:** Bundling documentation updates, small fixes, and a feature into a single `feat:` commit.
* ✅ **CORRECT:** Splitting them into three sequential commits: `docs:`, `fix:`, and `feat:`.

### #2: Missing Traceability

* ❌ **WRONG:** Omitting the **Files:** section or using vague descriptions like "modified source files".
* ✅ **CORRECT:** Listing precise absolute file paths for every commit entry.

### #3: Incorrect Breaking Change Syntax

* ❌ **WRONG:** Writing `feat: breaking change!` or `feat (breaking): description`.
* ✅ **CORRECT:** Appending the exclamation mark to the type: `feat!: description`.

### #4: Wrong Execution in Plan Mode

* ❌ **WRONG:** Running git commands or editing files when `PLAN MODE` is explicitly requested.
* ✅ **CORRECT:** Halting immediately after outputting the formatted text plan.

### #5: Out-of-Order Dependencies

* ❌ **WRONG:** Committing a feature that depends on a refactored utility function *before* committing the refactor itself.
* ✅ **CORRECT:** Ordering the refactor commit first, followed by the feature commit.

### #6: File Reference Standard

Never use absolute paths that include user-specific directories. Always provide relative paths from the project root to ensure clarity and consistency.

* ❌ **WRONG:** /home/<user>/<subpath>/<project>/packages/core/src/profile.ts
* ✅ **CORRECT:** packages/core/src/profile.ts

---

## Quick Reference Checklist

Before outputting or executing, verify:

* [ ] **Mode Verified:** Are you strictly adhering to the limits of PLAN MODE or BUILD MODE?
* [ ] **SRP Check:** Are unrelated changes safely isolated into separate commits?
* [ ] **Semantic Prefix:** Does every single commit start with an approved type?
* [ ] **Breaking Changes:** Is the `!` appended correctly if structural changes occurred?
* [ ] **File Trailing:** Are all modified relative paths explicitly listed?
* [ ] **Execution Order:** Do structural prep-commits come before implementation-commits?