# @atisse/provider-openai

## 1.0.1

### Patch Changes

- ### `@atisse/core`
  - Context provider outputs are now capped at 50 messages and 50,000 characters per provider. When either limit is exceeded, the output is truncated and a warning is logged.
  - The `context.loaded` event's `messageCount` field now reflects the truncated message count (after limits are applied).

  ### `@atisse/memory-redis`
  - `RedisMemoryAdapter` constructor now accepts an optional `keyPrefix` parameter in both config shapes:
    - `{ client, keyPrefix? }` — when passing an existing Redis client
    - `{ url, ttlSeconds?, keyPrefix? }` — when passing connection details
  - Default key prefix remains `'atisse:session:'`, so existing usage is fully backward-compatible.

  ### `@atisse/core`, `@atisse/memory-inmemory`, `@atisse/provider-openai`, `@atisse/provider-anthropic`, `@atisse/memory-redis`, `@atisse/context-rag`
  - Added `author`, `repository`, `bugs`, `homepage`, and `keywords` sections to each package's `package.json` file, improving package metadata and discoverability.
  - `README.md` files have been added to each package, providing a brief overview and usage instructions.

- Updated dependencies
  - @atisse/core@1.0.1

## 1.0.0

### Major Changes

- First stable release — v1.0.0. Public API is frozen per interfaces-core.md and interfaces-runtime.md. All M1–M5 exit criteria satisfied.

### Patch Changes

- Updated dependencies
  - @atisse/core@1.0.0

## 0.1.0

### Patch Changes

- Updated dependencies
  - @atisse/core@0.1.0
