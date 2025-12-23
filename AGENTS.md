# Burrow Repository Agent Instructions

## Core Project Identity

Burrow is a TypeScript-based CLI tool for managing directory-scoped secrets, built on the Bun runtime. It provides a platform-agnostic secrets manager that stores secrets outside repositories under the user profile directory, with inheritance through directory ancestry. The tool targets Linux, macOS, and Windows, distributed as single-file compiled binaries.

## Key Development Requirements

Before committing work, developers must execute two critical checks:
- `bun run typecheck` to verify TypeScript compliance
- `bun test` to ensure all test suites pass

The codebase uses Bun exclusively. Prefer Bun APIs over Node.js equivalents where available (`Bun.file` over `node:fs`, `Bun.write` for file operations). The CLI compiles to standalone binaries using `bun build --compile`.

## Architecture Overview

The codebase follows a layered architecture:
- `src/platform/` handles OS-specific config directory resolution (XDG on Unix, APPDATA on Windows)
- `src/storage/` manages atomic JSON store operations with temp file + rename pattern
- `src/core/` contains path canonicalization, secret resolution with inheritance, and export formatters
- `src/api.ts` exposes the public `BurrowClient` class used by both CLI and library consumers
- `src/cli.ts` provides the thin CLI wrapper over the API

The CLI must always call the same public API that library consumers use. Direct storage access from CLI code is prohibited.

## Secret Resolution Rules

Secrets resolve through directory ancestry from shallow to deep. When resolving secrets for a directory:
1. Find all stored scope paths that are ancestors of the target
2. Sort from shallowest to deepest
3. Merge key/value entries, with deeper scopes overriding shallower ones
4. Tombstones (null values) remove inherited keys from the merged result

Environment variable keys must match `^[A-Z_][A-Z0-9_]*$`.

## Documentation Maintenance Strategy

The `site/index.html` serves as the primary public documentation and must stay synchronized with CLI capabilities. When adding new commands or flags, update both the help text in `src/cli.ts` and the usage examples in the site.

The installation script `site/install.sh` must work on Linux and macOS across x64 and arm64 architectures.

## Testing Conventions

Tests use Bun's native test runner with files in the `tests/` directory. Each test file should create isolated temporary directories for storage to avoid test interference. Clean up test artifacts in `afterEach` hooks.

## Commit Standards

All commits must follow Conventional Commits format with lowercase types (feat, fix, chore, test, docs), imperative mood verbs, and subject lines under 72 characters.
