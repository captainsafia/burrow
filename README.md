# burrow

Burrow is a platform-agnostic, directory-scoped secrets manager. Secrets are stored outside your repos in a local SQLite store and exportable to various formats via the CLI. Secret values are encrypted at rest before being written to SQLite.

<p align="center">
  <img src="demo.gif" alt="burrow demo" width="600">
</p>

```
~/projects/                     # DATABASE_URL, API_KEY defined here
├── app-a/                      # inherits both secrets
├── app-b/                      # inherits both, overrides API_KEY
│   └── tests/                  # blocks API_KEY (uses none)
└── app-c/                      # inherits both secrets
```

## Installation

**Linux/macOS:**

```bash
curl -fsSL https://i.captainsafia.sh/captainsafia/burrow | sh
```

## Usage

### Set a secret

```bash
# KEY=VALUE format
burrow set API_KEY=sk-live-abc123

# KEY VALUE format (separate arguments)
burrow set API_KEY sk-live-abc123

# KEY only (prompts for value)
burrow set API_KEY

# With a specific path
burrow set DATABASE_URL=postgres://localhost/mydb --path ~/projects
```

### Get a secret

```bash
burrow get API_KEY
burrow get API_KEY --format json
# Redact the secret value in output
burrow get API_KEY --redact
```

### List all secrets

```bash
burrow list
burrow list --format json
# Redact secret values in output
burrow list --redact
```

### Export to your shell

```bash
# Auto-detects your shell (bash, fish, powershell, cmd)
eval "$(burrow export)"

# Or specify a format explicitly
burrow export --format fish
burrow export --format powershell
burrow export --format dotenv
burrow export --format json
```

### Block inheritance

```bash
burrow unset API_KEY --path ~/projects/app/tests
```

### Remove a secret

```bash
burrow remove API_KEY --path ~/projects/app
```

Unlike `unset` which blocks inheritance, `remove` deletes the entry entirely, restoring inheritance from parent directories.

## How It Works

Secrets are stored in your user profile:
- **Linux/macOS:** `$XDG_CONFIG_HOME/burrow` or `~/.config/burrow`
- **Windows:** `%APPDATA%\burrow`

When you request secrets for a directory, burrow:

1. Finds all ancestor paths with stored secrets
2. Merges them from shallowest to deepest
3. Deeper scopes override shallower ones
4. Tombstones (from `unset`) block inheritance

### Encryption at rest

Burrow encrypts non-null secret values with AES-256-GCM before writing them to `store.db`.

- **Primary key storage:** Burrow uses `Bun.secrets` to store a per-config encryption key in the OS credential store (Keychain on macOS, libsecret providers on Linux, and Credential Manager on Windows).
- **Headless fallback:** if `Bun.secrets` is unavailable (for example in minimal CI containers without a running secret service), Burrow stores the key in `store.key` in the config directory with restrictive permissions on Unix.

### Migration strategy

Burrow uses a versioned database schema and encrypted payload format:

1. **Schema migration (v1 → v2):** on first access, Burrow upgrades legacy stores to schema version 2.
2. **In-place value migration:** all non-null plaintext values are encrypted and written back in place.
3. **Idempotent migration:** values already marked as encrypted are skipped, so migration can be safely retried.
4. **Future encrypted migrations:** encrypted payloads include a version prefix (`burrow:enc:v1:`), so future formats can be migrated deterministically.

## Library Usage

Burrow also works as a TypeScript/JavaScript library:

```typescript
import { BurrowClient } from '@captainsafia/burrow';

const client = new BurrowClient();

try {
  await client.set('API_KEY', 'secret123', { path: '/my/project' });

  const secret = await client.get('API_KEY', { cwd: '/my/project/subdir' });
  console.log(secret?.value); // 'secret123'
  console.log(secret?.sourcePath); // '/my/project'

  const allSecrets = await client.list({ cwd: '/my/project' });
} finally {
  client.close(); // Clean up database connection
}
```

Or with TypeScript's `using` declarations for automatic cleanup:

```typescript
{
  using client = new BurrowClient();
  await client.set('API_KEY', 'secret123');
} // Automatically cleaned up
```

## Contributing

### Prerequisites

- [Bun](https://bun.sh) v1.0 or later

### Setup

```bash
git clone https://github.com/captainsafia/burrow.git
cd burrow
bun install
```

### Development

```bash
# Run tests
bun test

# Type check
bun run typecheck

# Build npm package
bun run build

# Compile binary
bun run compile
```

## License

MIT
