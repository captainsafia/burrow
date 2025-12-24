import { Storage } from "./storage/index.ts";
import {
  Resolver,
  type ResolvedSecret,
  canonicalize,
  format,
  assertValidEnvKey,
  type ExportFormat,
  type PathOptions,
} from "./core/index.ts";

export type { ResolvedSecret };
export type { ExportFormat };

/**
 * Configuration options for creating a BurrowClient instance.
 */
export interface BurrowClientOptions {
  /**
   * Custom directory for storing the secrets database.
   * Defaults to platform-specific user config directory:
   * - Linux/macOS: `$XDG_CONFIG_HOME/burrow` or `~/.config/burrow`
   * - Windows: `%APPDATA%\burrow`
   *
   * Can also be set via the `BURROW_CONFIG_DIR` environment variable.
   */
  configDir?: string;

  /**
   * Custom filename for the secrets store.
   * Defaults to `store.db`.
   */
  storeFileName?: string;

  /**
   * Whether to follow symlinks when canonicalizing paths.
   * Defaults to `true`.
   */
  followSymlinks?: boolean;
}

/**
 * Options for the `set` method.
 */
export interface SetOptions {
  /**
   * Directory path to scope the secret to.
   * Defaults to the current working directory.
   */
  path?: string;
}

/**
 * Options for the `get` method.
 */
export interface GetOptions {
  /**
   * Directory to resolve secrets from.
   * Secrets are inherited from ancestor directories.
   * Defaults to the current working directory.
   */
  cwd?: string;
}

/**
 * Options for the `list` method.
 */
export interface ListOptions {
  /**
   * Directory to resolve secrets from.
   * Secrets are inherited from ancestor directories.
   * Defaults to the current working directory.
   */
  cwd?: string;
}

/**
 * Options for the `block` method.
 */
export interface BlockOptions {
  /**
   * Directory path to scope the tombstone to.
   * Defaults to the current working directory.
   */
  path?: string;
}

/**
 * Options for the `remove` method.
 */
export interface RemoveOptions {
  /**
   * Directory path to remove the secret from.
   * Defaults to the current working directory.
   */
  path?: string;
}

/**
 * Options for the `export` method.
 */
export interface ExportOptions {
  /**
   * Directory to resolve secrets from.
   * Secrets are inherited from ancestor directories.
   * Defaults to the current working directory.
   */
  cwd?: string;

  /**
   * Output format for the exported secrets.
   * - `shell`: Exports as `export KEY='value'` statements (default)
   * - `dotenv`: Exports as `KEY="value"` lines
   * - `json`: Exports as a JSON object
   */
  format?: ExportFormat;

  /**
   * Whether to include source paths in JSON output.
   * When true, JSON output includes `{ key: { value, sourcePath } }` format.
   * Only applies when format is `json`.
   */
  includeSources?: boolean;
}

/**
 * Client for managing directory-scoped secrets.
 *
 * Secrets are stored outside your repository in the user's config directory
 * and are scoped to filesystem paths. Child directories automatically inherit
 * secrets from parent directories, with deeper scopes overriding shallower ones.
 *
 * @example
 * ```typescript
 * import { BurrowClient } from '@captainsafia/burrow';
 *
 * const client = new BurrowClient();
 *
 * // Set a secret scoped to a directory
 * await client.set('API_KEY', 'sk-live-abc123', { path: '/projects/myapp' });
 *
 * // Get a secret (inherits from parent directories)
 * const secret = await client.get('API_KEY', { cwd: '/projects/myapp/src' });
 * console.log(secret?.value); // 'sk-live-abc123'
 *
 * // Export secrets for shell usage
 * const shellExport = await client.export({ format: 'shell' });
 * // Returns: export API_KEY='sk-live-abc123'
 * ```
 */
export class BurrowClient {
  private readonly storage: Storage;
  private readonly resolver: Resolver;
  private readonly pathOptions: PathOptions;

  /**
   * Creates a new BurrowClient instance.
   *
   * @param options - Configuration options for the client
   */
  constructor(options: BurrowClientOptions = {}) {
    this.storage = new Storage({
      configDir: options.configDir,
      storeFileName: options.storeFileName,
    });
    this.resolver = new Resolver({
      storage: this.storage,
      followSymlinks: options.followSymlinks,
    });
    this.pathOptions = {
      followSymlinks: options.followSymlinks,
    };
  }

  /**
   * Sets a secret at the specified path scope.
   *
   * The secret will be available to the specified directory and all its
   * subdirectories, unless overridden or blocked at a deeper level.
   *
   * @param key - Environment variable name. Must match `^[A-Za-z_][A-Za-z0-9_]*$`
   * @param value - Secret value to store
   * @param options - Set options including target path
   * @throws Error if the key format is invalid
   *
   * @example
   * ```typescript
   * // Set at current directory
   * await client.set('DATABASE_URL', 'postgres://localhost/mydb');
   *
   * // Set at specific path
   * await client.set('API_KEY', 'secret', { path: '/projects/myapp' });
   * ```
   */
  async set(key: string, value: string, options: SetOptions = {}): Promise<void> {
    assertValidEnvKey(key);

    const targetPath = options.path ?? process.cwd();
    const canonicalPath = await canonicalize(targetPath, this.pathOptions);

    await this.storage.setSecret(canonicalPath, key, value);
  }

  /**
   * Gets a secret resolved through directory ancestry.
   *
   * Starting from the specified directory (or cwd), walks up the directory
   * tree to find the nearest scope that defines the key. Deeper scopes
   * override shallower ones.
   *
   * @param key - Environment variable name to retrieve
   * @param options - Get options including working directory
   * @returns The resolved secret with its source path, or undefined if not found
   *
   * @example
   * ```typescript
   * const secret = await client.get('API_KEY', { cwd: '/projects/myapp/src' });
   * if (secret) {
   *   console.log(secret.value);      // The secret value
   *   console.log(secret.sourcePath); // Path where it was defined
   * }
   * ```
   */
  async get(key: string, options: GetOptions = {}): Promise<ResolvedSecret | undefined> {
    return this.resolver.get(key, options.cwd);
  }

  /**
   * Lists all secrets resolved for a directory.
   *
   * Returns all secrets that would be available in the specified directory,
   * including those inherited from parent directories. Each secret includes
   * its source path indicating where it was defined.
   *
   * @param options - List options including working directory
   * @returns Array of resolved secrets sorted by key name
   *
   * @example
   * ```typescript
   * const secrets = await client.list({ cwd: '/projects/myapp' });
   * for (const secret of secrets) {
   *   console.log(`${secret.key} from ${secret.sourcePath}`);
   * }
   * ```
   */
  async list(options: ListOptions = {}): Promise<ResolvedSecret[]> {
    return this.resolver.list(options.cwd);
  }

  /**
   * Blocks a secret from being inherited at the specified path.
   *
   * Creates a "tombstone" that prevents the key from being inherited from
   * parent directories. The block only affects the specified directory and
   * its subdirectories. The secret remains available in parent directories.
   *
   * A blocked key can be re-enabled by calling `set` at the same or deeper path.
   *
   * @param key - Environment variable name to block. Must match `^[A-Za-z_][A-Za-z0-9_]*$`
   * @param options - Block options including target path
   * @throws Error if the key format is invalid
   *
   * @example
   * ```typescript
   * // Parent has API_KEY defined
   * await client.set('API_KEY', 'prod-key', { path: '/projects' });
   *
   * // Block it in the test directory
   * await client.block('API_KEY', { path: '/projects/myapp/tests' });
   *
   * // Now API_KEY won't resolve in /projects/myapp/tests or below
   * const secret = await client.get('API_KEY', { cwd: '/projects/myapp/tests' });
   * console.log(secret); // undefined
   * ```
   */
  async block(key: string, options: BlockOptions = {}): Promise<void> {
    assertValidEnvKey(key);

    const targetPath = options.path ?? process.cwd();
    const canonicalPath = await canonicalize(targetPath, this.pathOptions);

    await this.storage.setSecret(canonicalPath, key, null);
  }

  /**
   * Removes a secret entry entirely from the specified path.
   *
   * Unlike `block`, which creates a tombstone to prevent inheritance,
   * `remove` completely deletes the secret entry. After removal, the key
   * may still be inherited from parent directories if defined there.
   *
   * @param key - Environment variable name to remove. Must match `^[A-Za-z_][A-Za-z0-9_]*$`
   * @param options - Remove options including target path
   * @returns true if the secret was found and removed, false if it didn't exist
   * @throws Error if the key format is invalid
   *
   * @example
   * ```typescript
   * // Set a secret
   * await client.set('API_KEY', 'secret', { path: '/projects/myapp' });
   *
   * // Remove it entirely
   * const removed = await client.remove('API_KEY', { path: '/projects/myapp' });
   * console.log(removed); // true
   *
   * // Trying to remove again returns false
   * const removedAgain = await client.remove('API_KEY', { path: '/projects/myapp' });
   * console.log(removedAgain); // false
   * ```
   */
  async remove(key: string, options: RemoveOptions = {}): Promise<boolean> {
    assertValidEnvKey(key);

    const targetPath = options.path ?? process.cwd();
    const canonicalPath = await canonicalize(targetPath, this.pathOptions);

    return this.storage.removeKey(canonicalPath, key);
  }

  /**
   * Exports resolved secrets in various formats.
   *
   * Generates a formatted string of all secrets resolved for the specified
   * directory, suitable for shell evaluation or configuration files.
   *
   * @param options - Export options including format and working directory
   * @returns Formatted string of secrets
   *
   * @example
   * ```typescript
   * // Shell format (default) - use with eval
   * const shell = await client.export({ format: 'shell' });
   * // Returns: export API_KEY='value'\nexport DB_URL='...'
   *
   * // Dotenv format - save to .env file
   * const dotenv = await client.export({ format: 'dotenv' });
   * // Returns: API_KEY="value"\nDB_URL="..."
   *
   * // JSON format - for programmatic use
   * const json = await client.export({ format: 'json' });
   * // Returns: { "API_KEY": "value", "DB_URL": "..." }
   *
   * // JSON with source paths
   * const jsonWithSources = await client.export({
   *   format: 'json',
   *   includeSources: true
   * });
   * // Returns: { "API_KEY": { "value": "...", "sourcePath": "/..." } }
   * ```
   */
  async export(options: ExportOptions = {}): Promise<string> {
    const secrets = await this.resolver.resolve(options.cwd);
    const fmt = options.format ?? "shell";

    return format(secrets, fmt, {
      includeSources: options.includeSources,
    });
  }

  /**
   * Resolves all secrets for a directory as a Map.
   *
   * Lower-level method that returns the raw resolution result. Useful for
   * programmatic access when you need to iterate over secrets or perform
   * custom processing.
   *
   * @param cwd - Directory to resolve secrets from. Defaults to current working directory.
   * @returns Map of key names to resolved secrets
   *
   * @example
   * ```typescript
   * const secrets = await client.resolve('/projects/myapp');
   * for (const [key, secret] of secrets) {
   *   console.log(`${key}=${secret.value} (from ${secret.sourcePath})`);
   * }
   * ```
   */
  async resolve(cwd?: string): Promise<Map<string, ResolvedSecret>> {
    return this.resolver.resolve(cwd);
  }

  /**
   * Closes the database connection and releases resources.
   * After calling this method, the client instance should not be used.
   *
   * This method is safe to call multiple times.
   *
   * @example
   * ```typescript
   * const client = new BurrowClient();
   * try {
   *   await client.set('API_KEY', 'value');
   *   // ... do work
   * } finally {
   *   client.close();
   * }
   * ```
   */
  close(): void {
    this.storage.close();
  }

  /**
   * Allows using the BurrowClient with `using` declarations for automatic cleanup.
   *
   * @example
   * ```typescript
   * {
   *   using client = new BurrowClient();
   *   await client.set('API_KEY', 'value');
   * } // client.close() is called automatically
   * ```
   */
  [Symbol.dispose](): void {
    this.close();
  }
}

/**
 * Creates a new BurrowClient instance.
 *
 * Convenience function equivalent to `new BurrowClient(options)`.
 *
 * @param options - Configuration options for the client
 * @returns A new BurrowClient instance
 *
 * @example
 * ```typescript
 * import { createClient } from '@captainsafia/burrow';
 *
 * const client = createClient({
 *   configDir: '/custom/config/path'
 * });
 * ```
 */
export function createClient(options?: BurrowClientOptions): BurrowClient {
  return new BurrowClient(options);
}
