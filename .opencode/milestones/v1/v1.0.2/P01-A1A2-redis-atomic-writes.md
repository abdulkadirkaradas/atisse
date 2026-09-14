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

This violates **Principle 4 (Stateless Core)** — which guarantees that concurrent `run()` calls must not interfere — and ADR-041 (`RedisClientPool.execute()` for connection isolation).

node-redis v6 provides `RedisClientPool.execute()` for connection isolation; `WATCH`/`MULTI`/`EXEC` optimistic locking throws `WatchError` on abort (not returns `null`). The fix uses `WATCH` on the key inside a `pool.execute()` callback, then performs the read and conditional write within `MULTI`/`EXEC`, retrying on `WatchError`.

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
| Fix         | Replace with Redis `WATCH`/`MULTI`/`EXEC` transaction via `RedisClientPool.execute()`: acquire pooled connection → WATCH key → GET → append messages → SETEX inside MULTI → EXEC → retry on `WatchError` (thrown, not `null`). |

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
// Imports (add to existing import block):
import { WatchError } from 'redis';
import { ContextLoadError, MemorySaveError } from '@atisse/core';

async save(sessionId: string, messages: Message[]): Promise<void> {
  await this.ensureConnected();
  const key = `${this.keyPrefix}${sessionId}`;
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      // WATCH is connection-scoped state in node-redis v6. On a shared client,
      // concurrent save() calls could interleave their WATCH/MULTI/EXEC
      // sequences on the same underlying connection and corrupt the lock.
      // RedisClientPool.execute() gives this transaction a dedicated connection.
      const pool = await this.client.createPool();
      await pool.connect();
      const committed = await pool.execute(async (isolatedClient) => {
        try {
          // Optimistic lock: WATCH the key (on the pooled client)
          await isolatedClient.watch(key);

          // Read existing data inside watch
          const raw = await isolatedClient.get(key);
          const existing: Message[] = raw === null ? [] : (JSON.parse(raw) as Message[]);
          const merged = [...existing, ...messages];
          const value = JSON.stringify(merged);

          // Execute transaction: SET with TTL
          try {
            await isolatedClient
              .multi()
              .setEx(key, this.ttlSeconds, value)
              .exec();
            return true;
          } catch (error: unknown) {
            if (error instanceof WatchError) return false; // WATCH triggered — key modified by another client
            throw error;
          }
        } catch (error: unknown) {
          // Pool-managed connection lifecycle: #returnClient → resetIfDirty
          // resets WATCH state automatically. No manual unwatch() needed.
          throw error;
        }
      });

      if (committed) return; // Success

      // WATCH triggered — retry the transaction
      attempt++;
    } catch (error: unknown) {
      // Never call this.client.unwatch() — no WATCH is active on the shared connection.
      throw new MemorySaveError(error);
    }
  }

  // Max retries exceeded
  throw new MemorySaveError(new Error('Transaction failed after max retries'));
}
```

**Key design decisions:**

- **Prefer `MULTI`/`EXEC` over Lua scripting:** Keeps existing data shape. Lua would be more efficient but adds deployment complexity (script loading, SHA referencing).
- **Isolated connection via `RedisClientPool.execute()` (`createClientPool` / `client.createPool`):** node-redis v6 has removed the v4-era `executeIsolated()`. The v4→v5 migration guide states: _"In v4, RedisClient had the ability to create a pool of connections using an 'Isolation Pool'... In v5 we've extracted this pool logic into its own class—RedisClientPool."_ In v6, `pool.execute()` acquires a dedicated connection, runs the callback, and returns it via `#returnClient()` (`pool.js:313`) — guaranteeing no other `save()` call can interleave commands on the same underlying connection. v4→v5 migration: Isolation Pool → `RedisClientPool`; v6's `pool.execute()` provides the dedicated connection; `WatchError` throw on abort.
- **Retry on WATCH failure:** Standard optimistic-locking pattern. Up to 3 retries with no delay — Redis transactions are fast; contention is rare. node-redis v6 `_executeMulti` (`@redis/client@6.2.1` `lib/client/index.js:1318-1319`) throws `WatchError` when `execResult === null`.
- **Pool-managed connection lifecycle:** `#returnClient()` → `resetIfDirty()` (`pool.js`) automatically resets `#watchEpoch`/`#dirtyWatch` client internals when the pooled connection is returned. No manual `unwatch()` is required or possible inside the pool callback after the callback returns. See `redis` v6 `RedisClientPool` docs.
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

**Import change:** Already covered by §4.1's import block — it adds both `WatchError` from `'redis'` and `MemorySaveError` from `'@atisse/core'`:

```typescript
import { WatchError } from 'redis';
import { ContextLoadError, MemorySaveError } from '@atisse/core';
```

### 4.3 What NOT to Do

- Do NOT change the `MemoryAdapter` interface — it remains `save(sessionId, messages: Message[]): Promise<void>`
- Do NOT change the `RedisMemoryAdapter` constructor or public API
- Do NOT introduce a Lua script — `MULTI`/`EXEC` is sufficient
- Do NOT add a sleep/delay between transaction retries — delay is unnecessary for optimistic locking
- Do NOT change `load()` error handling — it correctly throws `ContextLoadError`
- Do NOT use `SET` instead of `SETEX` — TTL must be preserved
- Do NOT attempt to use v4-era `client.executeIsolated()` or `commandOptions({ isolated: true })` — neither exists in `redis@^6.0.0`; use `RedisClientPool.execute()` (`this.client.createPool()`). Do NOT call `isolatedClient.unwatch()` manually inside the pool callback — the pool manages connection lifecycle via `#returnClient` → `resetIfDirty()`, which reset `#watchEpoch`/`#dirtyWatch` automatically.

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
- Import `MemorySaveError` from `@atisse/core` and `WatchError` from `redis` (needed for both Phase 1 and Phase 2)
- Replace the `save()` method body (lines 45–55) with the WATCH/MULTI/EXEC pattern described in §4.1
- Keep the `await this.ensureConnected()` call at the top
- Set max transaction retries to 3
- Use `this.client.createPool()` / `pool.execute(async (isolatedClient) => { ... })` — all `watch()`, `multi()`, `.exec()` calls run on `isolatedClient`, NEVER on the shared `this.client`

### Step 2: Handle `WatchError` in Error Path

- Inside the `pool.execute` callback, wrap the transaction body in try/catch; in the inner try/catch around `multi().exec()`, catch `WatchError` and return `false` (retry signal), rethrow all other errors
- Do NOT call `isolatedClient.unwatch()` — the pool manages connection lifecycle via `#returnClient` → `resetIfDirty()`, which resets WATCH state automatically
- Outer catch: throw `MemorySaveError(error)` — real transaction errors surface as `MemorySaveError` (non-retryable)

### Phase 2: A2 — Error Type Fix

### Step 3: Fix Imports

- No separate import change is needed — Step 1 already adds the merged import block from §4.1 (`WatchError` from `'redis'` and `MemorySaveError` from `'@atisse/core'`):
  ```typescript
  import { WatchError } from 'redis';
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
- WATCH/MULTI/EXEC run on a pool-acquired client via `pool.execute()` — no `watch()`/`multi()`/`exec()` call targets `this.client` directly (assert via `vi.spyOn` on `createClientPool`/`pool.execute` instead — verify the pooled client receives the calls, never the shared `this.client`)
- On successful transaction, `exec()` resolves without throwing and the method completes normally
- On WATCH failure (`exec()` throws `WatchError`), the method retries up to 3 times
- After max retries, `MemorySaveError` is thrown
- Concurrent `save()` calls for the same `sessionId` do not overwrite each other (stress test) — shared `this.client` but each gets a dedicated pooled connection, no `executeIsolated` spy

### Phase 2 (A2):

- `save()` error → `MemorySaveError` (not `ContextLoadError`)
- `clear()` error → `MemorySaveError` (not `ContextLoadError`)
- `load()` error → `ContextLoadError` (unchanged)
- `isRetryable(new MemorySaveError(...))` returns `false`
- `isRetryable(new ContextLoadError(...))` returns `true`
- All existing tests pass without modification

---

## 8. Risk Assessment

| Risk                                                                                           | Likelihood   | Impact   | Mitigation                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (A1) Transaction retry loop never breaks on persistent contention                              | Very Low     | Medium   | Max 3 retries with no delay — persistent contention is extremely rare for append-only conversation history                                                                                                  |
| (A1) `WATCH`/`MULTI`/`EXEC` interleaving between concurrent `save()` calls                       | Impossible | High   | In v6, `WATCH`/`MULTI`/`EXEC` run inside `RedisClientPool.execute()`, giving each `save()` a dedicated connection — interleaving is impossible. The only risk is pool lifecycle management: `createPool()`/`connect()`/`close()`. |
| (A1) `WatchError` throw vs null semantics                                                      | Low        | Medium | node-redis v6 `_executeMulti` (`@redis/client@6.2.1` `lib/client/index.js:1318-1319`) throws `WatchError` when `execResult === null`. Catch `WatchError` → retry signal; never check `result === null`.         |
| (A2) Existing code catches `ContextLoadError` from `save()`                                    | Low        | Medium | The kernel catches `save()` errors generically in `finalizePipeline()` line 605: `throw new MemorySaveError(error)` already wraps the error. No consumer catches `ContextLoadError` specifically from save. |
| (A2) `save()` no longer calls `this.load()`, so the old `ContextLoadError` catch was redundant | Very Low   | Low    | Correct — the new transaction reads directly from Redis via `this.client.get(key)` inside the WATCH block                                                                                                   |
| `redis` client version                                                                         | Low        | Low    | The `redis@^6.0.0` declaration is correct; the v6 `RedisClientPool.execute()` + `WatchError` import path is verified.                                                                                               |

---

## 9. References

- `.opencode/skill/principles/SKILL.md` — Principle 4: Stateless Core (concurrent run() isolation)
- `DECISION-LOG.md` — ADR-004, ADR-007, ADR-041 (`RedisClientPool.execute()` for connection isolation)
- `.opencode/skill/errors/SKILL.md` — MemorySaveError (non-retryable), ContextLoadError (retryable)
- `.opencode/skill/interfaces/SKILL.md` — MemoryAdapter interface, OrchestratorErrorCode
- `packages/memory-redis/src/index.ts` — Target file: save(), clear(), load() methods
- `packages/core/src/errors.ts` — MemorySaveError class (already exists)
- `packages/memory-redis/package.json` — Dependency declaration for `redis` client (`^6.0.0`)
- node-redis v6 `RedisClientPool` docs — `pool.execute()` acquires a dedicated connection, returns via `#returnClient()`; `WatchError` throw semantics
