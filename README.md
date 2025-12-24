# burrow

A platform-agnostic, directory-scoped secrets manager. Store secrets outside your repos, inherit them through directory ancestry.

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
curl -fsSL https://safia.rocks/burrow/install.sh | sh
```

## Usage

### Set a secret

```bash
burrow set API_KEY=sk-live-abc123
burrow set DATABASE_URL=postgres://localhost/mydb --path ~/projects
```

### Get a secret

```bash
burrow get API_KEY --show
burrow get API_KEY --format json
```

### List all secrets

```bash
burrow list
burrow list --format json
```

### Export to your shell

```bash
eval "$(burrow export)"
eval "$(burrow export --format shell)" && npm start
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

## Library Usage

Burrow also works as a TypeScript/JavaScript library:

```typescript
import { BurrowClient } from '@captainsafia/burrow';

const client = new BurrowClient();

await client.set('API_KEY', 'secret123', { path: '/my/project' });

const secret = await client.get('API_KEY', { cwd: '/my/project/subdir' });
console.log(secret?.value); // 'secret123'
console.log(secret?.sourcePath); // '/my/project'

const allSecrets = await client.list({ cwd: '/my/project' });
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
