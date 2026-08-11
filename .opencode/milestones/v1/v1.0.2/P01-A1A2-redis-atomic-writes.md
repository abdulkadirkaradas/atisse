# A1–A2 — Redis Adapter Reliability: Atomic Writes + Error Type Fix

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

This plan covers two items for `packages/memory-redis/src/index.ts`:

### Phase 1 (A1): Redis Atomic Writes — CRITICAL priority

Replace the read-modify-write (RMW) pattern in `RedisMemoryAdapter.save()` with Redis `WATCH`/`MULTI`/`EXEC` transactions to guarantee atomicity under concurrent `run()` calls.

### Phase 2 (A2): Error Type Semantic Mismatch — HIGH priority

Fix `save()` and `clear()` to throw `MemorySaveError` (non-retryable, `MEMORY_SAVE_FAILED`) instead of `ContextLoadError` (retryable, `CONTEXT_LOAD_FAILED`). Keep `load()` on `ContextLoadError`.

**Ordering:** Phase 2 is best done after Phase 1 since the error paths are rewritten during Phase 1.

---

## 2. Context (Why This Exists)

### Phase 1 — A1: Atomic Writes

`RedisMemoryAdapter.save()` in `packages/memory-redis/src/index.ts` lines 45–55 uses a read-modify-write (RMW) pattern:

```typescript
async save(sessionId: string, messages: Message[]): Promise<void> {
  await this.ensureConnected();
  try {
    const existing = await this.load(sessionId);     // 1) READ
    const key = `${this.keyPrefix}${sessionId}`;
    await this.client.setEx(key, this.ttlSeconds,     // 2) WRITE
      JSON.stringify([...existing, ...messages]));
  } catch (error: unknown) {
    if (error instanceof ContextLoadError) throw error;
    throw new ContextLoadError(this.id, error);
  }
}
```

This is a classic read-modify-write race condition. Two concurrent `run()` calls for the same `sessionId` can:

1. **Call A reads** (current messages: `[m1]`) → `existing = [m1]`
2. **Call B reads** (current messages: `[m1]`) → `existing = [m1]`
3. **Call A writes** `[m1, m2]` → `[m1, ma]`
4. **Call B writes** `[m1, m3]` → overwrites Call A's `[m1, ma]` with `[m1, mb]`

**Call A's messages (`ma`) are silently lost.**

This violates **Principle 4 (Stateless Core)** — which guarantees that concurrent `run()` calls must not interfere — and ADR-004's concurrent-safety guarantee.

Redis v5 provides `WATCH`/`MULTI`/`EXEC` for optimistic locking. The fix uses `WATCH` on the key, then within `MULTI`/`EXEC` performs the read and conditional write, retrying on `WATCH` failure (when `EXEC` returns `null`).

### Phase 2 — A2: Error Type Mismatch

Currently, `save()` (line 53) and `clear()` (line 63) both catch errors and throw `ContextLoadError`:

```typescript
throw new ContextLoadError(this.id, error);
```

The error taxonomy (`error-taxonomy.md`) defines:

- `ContextLoadError` — retryable (`retryable: true`), code `CONTEXT_LOAD_FAILED`
- `MemorySaveError` — non-retryable (`retryable: false`), code `MEMORY_SAVE_FAILED`

`save()` and `clear()` are memory operations, not context load operations. They should throw `MemorySaveError`. `load()` correctly throws `ContextLoadError` — that is a load operation.

The semantic mismatch means a failed `save()` is classified as retryable, which is incorrect. Per ADR-007, retry decisions must correctly reflect the operation type.

---

## 3. Issues/Changes

### Phase 1 — A1: Race condition in save()

| Field       | Value                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/memory-redis/src/index.ts`                                                                                                               |
| Lines       | 45–55 (`save()` method)                                                                                                                            |
| Severity    | CRITICAL                                                                                                                                           |
| Description | `save()` uses RMW (GET + SETEX) without atomicity. Concurrent `run()` calls with the same `sessionId` can silently overwrite each other's data.    |
| Fix         | Replace with Redis `WATCH`/`MULTI`/`EXEC` transaction: WATCH key → GET inside MULTI → append messages → SETEX inside MULTI → EXEC → retry on null. |

### Phase 2 — A2: Error type mismatch

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File        | `packages/memory-redis/src/index.ts`                                                                                                                   |
| Lines       | 52–53 (`save()` catch), 62–63 (`clear()` catch)                                                                                                        |
| Severity    | HIGH                                                                                                                                                   |
| Description | `save()` and `clear()` throw `ContextLoadError` (retryable, `CONTEXT_LOAD_FAILED`) instead of `MemorySaveError` (non-retryable, `MEMORY_SAVE_FAILED`). |
| Fix         | Change catch blocks in `save()` and `clear()` to throw `MemorySaveError`. Keep `load()` on `ContextLoadError`.                                         |

---

## 4. Architectural Directives

### 4.1 Chosen Approach — Phase 1 (A1)

**Transaction pattern:**

```typescript
async save(sessionId: string, messages: Message[]): Promise<void> {
  await this.ensureConnected();
  const key = `${this.keyPrefix}${sessionId}`;
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      // Optimistic lock on an ISOLATED connection.
      // WATCH is connection-scoped state in node-redis v4/v5: on a shared
      // client, concurrent save() calls could interleave their WATCH/MULTI/EXEC
      // sequences on the same underlying connection and corrupt the lock.
      // executeIsolated() gives this transaction a dedicated connection.
      const committed = await this.client.executeIsolated(async (isolatedClient) => {
        try {
          // Optimistic lock: WATCH the key (on the isolated client)
          await isolatedClient.watch(key);

          // Read existing data inside watch
          const raw = await isolatedClient.get(key);
          const existing: Message[] = raw === null ? [] : (JSON.parse(raw) as Message[]);
          const merged = [...existing, ...messages];
          const value = JSON.stringify(merged);

          // Execute transaction: SET with TTL
          const result = await isolatedClient
            .multi()
            .setEx(key, this.ttlSeconds, value)
            .exec();

          // EXEC returns null when WATCH triggers (key was modified by another client)
          return result !== null;
        } catch (error: unknown) {
          // Unwatch on the ISOLATED client before rethrowing (defensive —
          // executeIsolated also releases the connection automatically).
          await isolatedClient.unwatch().catch(() => {});
          throw error;
        }
      });

      if (committed) return; // Success

      // WATCH triggered — retry the transaction
      attempt++;
    } catch (error: unknown) {
      // unwatch() already ran on the isolated client inside the callback.
      // NEVER call this.client.unwatch() — no WATCH is active on the shared connection.
      throw new MemorySaveError(error);
    }
  }

  // Max retries exceeded
  throw new MemorySaveError(new Error('Transaction failed after max retries'));
}
```

**Key design decisions:**

- **Prefer `MULTI`/`EXEC` over Lua scripting:** Keeps existing data shape. Lua would be more efficient but adds deployment complexity (script loading, SHA referencing).
- **Isolated connection via `executeIsolated()`:** `WATCH` is connection-scoped state in node-redis v4/v5. Running the entire WATCH/MULTI/EXEC sequence inside `client.executeIsolated()` guarantees no other command on the shared client can interleave, preserving the optimistic-lock guarantee under concurrent `save()` calls (see redis/node-redis issues #2613, #559).
- **Retry on WATCH failure:** Standard optimistic-locking pattern. Up to 3 retries with no delay — Redis transactions are fast; contention is rare.
- **`unwatch()` in catch (on the isolated client):** Ensures the watched key is released on error before the isolated connection is returned. `this.client.unwatch()` on the shared client would be a no-op — no WATCH is active there. See `redis` client v5 docs.
- **Existing `MemoryAdapter` interface requires NO change:** This is an internal implementation improvement.

### 4.2 Chosen Approach — Phase 2 (A2)

**Changes:**

In `save()` catch block (line 52–53):

```typescript
// Before:
if (error instanceof ContextLoadError) throw error;
throw new ContextLoadError(this.id, error);

// After:
throw new MemorySaveError(error);
```

In `clear()` catch block (line 62–63):

```typescript
// Before:
if (error instanceof ContextLoadError) throw error;
throw new ContextLoadError(this.id, error);

// After:
throw new MemorySaveError(error);
```

In `load()` catch block (line 40–41) — NO CHANGE:

```typescript
// Keep as-is — load is a context load operation
if (error instanceof ContextLoadError) throw error;
throw new ContextLoadError(this.id, error);
```

**Import change:** Add `MemorySaveError` to the import from `@atisse/core`:

```typescript
// Before:
import { ContextLoadError } from '@atisse/core';
// After:
import { ContextLoadError, MemorySaveError } from '@atisse/core';
```

### 4.3 What NOT to Do

- Do NOT change the `MemoryAdapter` interface — it remains `save(sessionId, messages: Message[]): Promise<void>`
- Do NOT change the `RedisMemoryAdapter` constructor or public API
- Do NOT introduce a Lua script — `MULTI`/`EXEC` is sufficient
- Do NOT add a sleep/delay between transaction retries — delay is unnecessary for optimistic locking
- Do NOT change `load()` error handling — it correctly throws `ContextLoadError`
- Do NOT use `SET` instead of `SETEX` — TTL must be preserved
- Do NOT add the `redis` client version guard — `WATCH`/`MULTI`/`EXEC` are standard and work with redis v4+; `package.json` should already declare the correct version

---

## 5. Files to Modify

| File                                 | Action      | Notes                                                 |
| ------------------------------------ | ----------- | ----------------------------------------------------- |
| `packages/memory-redis/src/index.ts` | MODIFY (A1) | Replace `save()` with WATCH/MULTI/EXEC transaction    |
| `packages/memory-redis/src/index.ts` | MODIFY (A2) | Fix `save()` and `clear()` to throw `MemorySaveError` |

---

## 6. Implementation Strategy

### Phase 1: A1 — Atomic Writes

### Step 1: Rewrite `save()` with Transaction

- Open `packages/memory-redis/src/index.ts`
- Import `MemorySaveError` from `@atisse/core` (needed for both Phase 1 and Phase 2)
- Replace the `save()` method body (lines 45–55) with the WATCH/MULTI/EXEC pattern described in §4.1
- Keep the `await this.ensureConnected()` call at the top
- Set max transaction retries to 3
- Use `this.client.executeIsolated(async (isolatedClient) => { ... })` — all `watch()`, `multi()`, `.exec()` calls run on `isolatedClient`, NEVER on the shared `this.client`

### Step 2: Handle `unwatch()` in Error Path

- Inside the `executeIsolated` callback, wrap the transaction body in try/catch; in the catch, call `await isolatedClient.unwatch().catch(() => {})` before rethrowing
- Do NOT call `this.client.unwatch()` on the shared client — no WATCH is active there; the isolated connection is released automatically when the callback returns or rejects
- The `.catch(() => {})` ensures the unwatch failure is not propagated — the original error is the one to surface

### Phase 2: A2 — Error Type Fix

### Step 3: Fix Imports

- Change the import line:
  ```typescript
  // Before:
  import { ContextLoadError } from '@atisse/core';
  // After:
  import { ContextLoadError, MemorySaveError } from '@atisse/core';
  ```

### Step 4: Fix `save()` Error Throw

- In `save()`, replace:
  ```typescript
  if (error instanceof ContextLoadError) throw error;
  throw new ContextLoadError(this.id, error);
  ```
  With:
  ```typescript
  throw new MemorySaveError(error);
  ```
  (Note: The `ContextLoadError` check is removed because it was a leftover from when `save()` called `this.load()` with RMW. In the new transaction pattern, `save()` reads directly from Redis inside the WATCH block and does not call `this.load()`, so a `ContextLoadError` from load is no longer possible.)

### Step 5: Fix `clear()` Error Throw

- In `clear()` (lines 57–65), replace:
  ```typescript
  if (error instanceof ContextLoadError) throw error;
  throw new ContextLoadError(this.id, error);
  ```
  With:
  ```typescript
  throw new MemorySaveError(error);
  ```

### Step 6: Verify

- Run `pnpm lint && pnpm typecheck && pnpm test -r` (recursive, includes all packages)
- All existing tests must pass without modification

---

## 7. Verification Requirements

After both phases, run:

```bash
pnpm lint
pnpm typecheck
pnpm test -r
```

Specific assertions to verify:

### Phase 1 (A1):

- `save()` uses `WATCH`/`MULTI`/`EXEC` — verify no bare `GET` + `SETEX` pattern remains
- WATCH/EXEC run on an isolated connection — no `watch()`/`multi()`/`exec()` call targets `this.client` directly (assert via `vi.spyOn(this.client, 'executeIsolated')` or equivalent)
- On successful transaction, `EXEC` returns non-null and the method completes normally
- On WATCH failure (`EXEC` returns `null`), the method retries up to 3 times
- After max retries, `MemorySaveError` is thrown
- Concurrent `save()` calls for the same `sessionId` do not overwrite each other (stress test)

### Phase 2 (A2):

- `save()` error → `MemorySaveError` (not `ContextLoadError`)
- `clear()` error → `MemorySaveError` (not `ContextLoadError`)
- `load()` error → `ContextLoadError` (unchanged)
- `isRetryable(new MemorySaveError(...))` returns `false`
- `isRetryable(new ContextLoadError(...))` returns `true`
- All existing tests pass without modification

---

## 8. Risk Assessment

| Risk                                                                                           | Likelihood | Impact | Mitigation                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (A1) Transaction retry loop never breaks on persistent contention                              | Very Low   | Medium | Max 3 retries with no delay — persistent contention is extremely rare for append-only conversation history                                                                                                  |
| (A1) `WATCH` on the shared client interleaves between concurrent `save()` calls                | Medium     | High   | `WATCH` is connection-scoped state — run the entire WATCH/MULTI/EXEC sequence inside `client.executeIsolated()` so each transaction gets a dedicated connection. Verify with a concurrent stress test.      |
| (A1) `unwatch()` call fails and shadows original error                                         | Low        | Low    | `.catch(() => {})` protects the original error                                                                                                                                                              |
| (A1) EXEC null vs empty array confusion                                                        | Low        | Medium | `client.exec()` in ioredis/redis v5 returns `[null, ...results]` on error or `null` when WATCH triggers. Verify with the installed redis client version.                                                    |
| (A2) Existing code catches `ContextLoadError` from `save()`                                    | Low        | Medium | The kernel catches `save()` errors generically in `finalizePipeline()` line 605: `throw new MemorySaveError(error)` already wraps the error. No consumer catches `ContextLoadError` specifically from save. |
| (A2) `save()` no longer calls `this.load()`, so the old `ContextLoadError` catch was redundant | Very Low   | Low    | Correct — the new transaction reads directly from Redis via `this.client.get(key)` inside the WATCH block                                                                                                   |
| `package.json` redis client version                                                            | Low        | Low    | Ensure `redis` client v4+ is declared — `WATCH`/`MULTI`/`EXEC` are supported in all versions ≥4                                                                                                             |

---

## 9. References

- `.opencode/skill/principles/SKILL.md` — Principle 4: Stateless Core (concurrent run() isolation)
- `DECISION-LOG.md` — ADR-004 (concurrent-safety guarantee), ADR-007 (error retryable classification)
- `.opencode/skill/errors/SKILL.md` — MemorySaveError (non-retryable), ContextLoadError (retryable)
- `.opencode/skill/interfaces/SKILL.md` — MemoryAdapter interface, OrchestratorErrorCode
- `packages/memory-redis/src/index.ts` — Target file: save(), clear(), load() methods
- `packages/core/src/errors.ts` — MemorySaveError class (already exists)
- `packages/memory-redis/package.json` — Dependency declaration for `redis` client
