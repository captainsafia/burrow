import { Storage } from "./storage/index.ts";
import {
  Resolver,
  type ResolvedSecret,
  canonicalize,
  format,
  assertValidEnvKey,
  type ExportFormat,
  type PathOptions,
  TrustManager,
  type TrustCheckResult,
  type LoadedSecret,
  type HookDiff,
  formatHookMessage,
  generateShellCommands,
  resolveToLoadedSecrets,
  computeHookDiff,
} from "./core/index.ts";
import { type TrustedPath } from "./storage/index.ts";

export type { ResolvedSecret };
export type { ExportFormat };
export type { TrustCheckResult };
export type { LoadedSecret, HookDiff };
export type { TrustedPath };

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
 * Options for the `trust` method.
 */
export interface TrustOptions {
  /**
   * Directory path to trust.
   * Defaults to the current working directory.
   */
  path?: string;
}

/**
 * Options for the `untrust` method.
 */
export interface UntrustOptions {
  /**
   * Directory path to untrust.
   * Defaults to the current working directory.
   */
  path?: string;
}

/**
 * Options for the `isTrusted` method.
 */
export interface IsTrustedOptions {
  /**
   * Directory path to check for trust.
   * Defaults to the current working directory.
   */
  path?: string;
}

/**
 * Result of the `trust` method.
 */
export interface TrustResult {
  /**
   * The canonicalized path that was trusted.
   */
  path: string;
  /**
   * The filesystem inode/file ID for the trusted path.
   */
  inode: string;
}

/**
 * Options for the `hook` method.
 */
export interface HookOptions {
  /**
   * The shell to generate hook commands for.
   */
  shell: "bash" | "zsh" | "fish";
  /**
   * Whether to use colored output.
   * Defaults to respecting NO_COLOR environment variable.
   */
  useColor?: boolean;
  /**
   * Keys that were previously loaded by the hook.
   * Used to compute which keys need to be unset.
   */
  previousKeys?: string[];
}

/**
 * Result of the `hook` method.
 */
export interface HookResult {
  /**
   * Shell commands to execute for environment updates.
   */
  commands: string[];
  /**
   * Optional message to display to the user.
   */
  message?: string;
  /**
   * The secrets that were loaded.
   */
  secrets: LoadedSecret[];
  /**
   * The keys that were unloaded.
   */
  unloadedKeys: string[];
  /**
   * Whether the directory is trusted.
   */
  trusted: boolean;
  /**
   * Reason if directory is not trusted.
   */
  notTrustedReason?: "not-trusted" | "inode-mismatch" | "path-not-found" | "autoload-disabled";
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
  private readonly trustManager: TrustManager;

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
    this.trustManager = new TrustManager({
      storage: this.storage,
      followSymlinks: options.followSymlinks,
    });
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
   * Trusts a directory for auto-loading secrets.
   *
   * When a directory is trusted, navigating into it (or its subdirectories)
   * will automatically load secrets into the shell environment via the hook.
   *
   * @param options - Trust options including target path
   * @returns The trusted path info with canonicalized path and inode
   *
   * @example
   * ```typescript
   * // Trust current directory
   * await client.trust();
   *
   * // Trust specific path
   * const result = await client.trust({ path: '/projects/myapp' });
   * console.log(`Trusted: ${result.path}`);
   * ```
   */
  async trust(options: TrustOptions = {}): Promise<TrustResult> {
    const targetPath = options.path ?? process.cwd();
    return this.trustManager.trust(targetPath);
  }

  /**
   * Removes trust from a directory.
   *
   * After untrusting, the directory (and its subdirectories) will no longer
   * auto-load secrets. Secrets currently loaded remain until the next directory change.
   *
   * @param options - Untrust options including target path
   * @returns true if the path was trusted and is now untrusted, false if it wasn't trusted
   *
   * @example
   * ```typescript
   * const removed = await client.untrust({ path: '/projects/myapp' });
   * if (removed) {
   *   console.log('Directory is no longer trusted');
   * }
   * ```
   */
  async untrust(options: UntrustOptions = {}): Promise<boolean> {
    const targetPath = options.path ?? process.cwd();
    return this.trustManager.untrust(targetPath);
  }

  /**
   * Checks if a directory is trusted for auto-loading.
   *
   * Trust can be inherited from ancestor directories. Also validates that
   * the inode matches to detect directory replacements.
   *
   * @param options - Options including path to check
   * @returns Trust check result with status and reason if not trusted
   *
   * @example
   * ```typescript
   * const result = await client.isTrusted({ path: '/projects/myapp/src' });
   * if (result.trusted) {
   *   console.log(`Trusted via: ${result.trustedPath}`);
   * } else {
   *   console.log(`Not trusted: ${result.reason}`);
   * }
   * ```
   */
  async isTrusted(options: IsTrustedOptions = {}): Promise<TrustCheckResult> {
    const targetPath = options.path ?? process.cwd();
    return this.trustManager.isTrusted(targetPath);
  }

  /**
   * Lists all trusted directories.
   *
   * @returns Array of all trusted path entries
   *
   * @example
   * ```typescript
   * const trusted = await client.listTrusted();
   * for (const entry of trusted) {
   *   console.log(`${entry.path} (trusted at ${entry.trustedAt})`);
   * }
   * ```
   */
  async listTrusted(): Promise<TrustedPath[]> {
    return this.trustManager.list();
  }

  /**
   * Processes a directory change for the shell hook.
   *
   * This is the main method called by shell hooks on directory change.
   * It checks trust, resolves secrets, computes the diff from previous
   * state, and returns the commands needed to update the environment.
   *
   * @param cwd - The new working directory
   * @param options - Hook options including shell type and previous keys
   * @returns Hook result with commands to execute and optional message
   *
   * @example
   * ```typescript
   * const result = await client.hook('/projects/myapp', { 
   *   shell: 'bash',
   *   previousKeys: ['OLD_KEY'] // Keys from last hook call
   * });
   * if (result.trusted) {
   *   for (const cmd of result.commands) {
   *     console.log(cmd); // Execute in shell
   *   }
   *   if (result.message) {
   *     console.error(result.message);
   *   }
   * }
   * ```
   */
  async hook(cwd: string, options: HookOptions): Promise<HookResult> {
    const previousKeys = new Set(options.previousKeys ?? []);

    // Check if autoload is disabled
    if (process.env["BURROW_AUTOLOAD"] === "0") {
      // Still need to unset any previously loaded keys
      const diff = computeHookDiff(previousKeys, []);
      const commands = generateShellCommands(diff, options.shell);
      const useColor = options.useColor ?? !process.env["NO_COLOR"];
      const message = diff.toUnset.length > 0 ? formatHookMessage(diff, useColor) : undefined;
      
      return {
        commands,
        message,
        secrets: [],
        unloadedKeys: diff.toUnset,
        trusted: false,
        notTrustedReason: "autoload-disabled",
      };
    }

    // Check if directory is trusted
    const trustResult = await this.isTrusted({ path: cwd });
    if (!trustResult.trusted) {
      // Unset any previously loaded keys when leaving trusted area
      const diff = computeHookDiff(previousKeys, []);
      const commands = generateShellCommands(diff, options.shell);
      const useColor = options.useColor ?? !process.env["NO_COLOR"];
      const message = diff.toUnset.length > 0 ? formatHookMessage(diff, useColor) : undefined;
      
      return {
        commands,
        message,
        secrets: [],
        unloadedKeys: diff.toUnset,
        trusted: false,
        notTrustedReason: trustResult.reason,
      };
    }

    // Resolve secrets for the directory
    const resolvedSecrets = await this.resolve(cwd);

    // Convert to loaded secrets format
    const secrets = resolveToLoadedSecrets(resolvedSecrets);

    // Compute diff from previous state
    const diff = computeHookDiff(previousKeys, secrets);

    // Generate shell commands
    const commands = generateShellCommands(diff, options.shell);

    // Generate message
    const useColor = options.useColor ?? !process.env["NO_COLOR"];
    const message = formatHookMessage(diff, useColor);

    return {
      commands,
      message,
      secrets,
      unloadedKeys: diff.toUnset,
      trusted: true,
    };
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
