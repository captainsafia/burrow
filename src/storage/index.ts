import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir } from "../platform/index.ts";
import { isWindows } from "../platform/index.ts";

const DEFAULT_STORE_FILE = "store.db";

export interface SecretEntry {
  value: string | null;
  updatedAt: string;
}

export interface PathSecrets {
  [key: string]: SecretEntry;
}

export interface TrustedPath {
  path: string;
  inode: string;
  trustedAt: string;
}

export interface StorageOptions {
  configDir?: string;
  storeFileName?: string;
}

export class Storage {
  private readonly configDir: string;
  private readonly storeFileName: string;
  private db: Database | null = null;

  constructor(options: StorageOptions = {}) {
    this.configDir = options.configDir ?? getConfigDir();
    this.storeFileName = options.storeFileName ?? DEFAULT_STORE_FILE;
  }

  private get storePath(): string {
    return join(this.configDir, this.storeFileName);
  }

  private async ensureDb(): Promise<Database> {
    if (this.db) {
      return this.db;
    }

    await mkdir(this.configDir, { recursive: true });

    // Set restrictive permissions on config directory (Unix only)
    if (!isWindows()) {
      await chmod(this.configDir, 0o700);
    }

    this.db = new Database(this.storePath);

    // Set restrictive permissions on database file (Unix only)
    if (!isWindows()) {
      await chmod(this.storePath, 0o600);
    }

    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS secrets (
        path TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (path, key)
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_secrets_path ON secrets (path)");

    // Create trusted_paths table for direnv-style auto-loading
    this.db.run(`
      CREATE TABLE IF NOT EXISTS trusted_paths (
        path TEXT PRIMARY KEY,
        inode TEXT NOT NULL,
        trusted_at TEXT NOT NULL
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_trusted_paths_inode ON trusted_paths (inode)");

    const versionResult = this.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get();
    const currentVersion = versionResult?.user_version ?? 0;

    if (currentVersion === 0) {
      this.db.run("PRAGMA user_version = 1");
    } else if (currentVersion !== 1) {
      throw new Error(
        `Unsupported store version: ${currentVersion}. Expected: 1`
      );
    }

    return this.db;
  }

  async setSecret(
    canonicalPath: string,
    key: string,
    value: string | null
  ): Promise<void> {
    const db = await this.ensureDb();
    const updatedAt = new Date().toISOString();

    db.query(`
      INSERT INTO secrets (path, key, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(canonicalPath, key, value, updatedAt);
  }

  async getPathSecrets(canonicalPath: string): Promise<PathSecrets | undefined> {
    const db = await this.ensureDb();

    const rows = db
      .query<{ key: string; value: string | null; updated_at: string }, [string]>(
        "SELECT key, value, updated_at FROM secrets WHERE path = ?"
      )
      .all(canonicalPath);

    if (rows.length === 0) {
      return undefined;
    }

    const secrets: PathSecrets = {};
    for (const row of rows) {
      secrets[row.key] = {
        value: row.value,
        updatedAt: row.updated_at,
      };
    }

    return secrets;
  }

  async getAllPaths(): Promise<string[]> {
    const db = await this.ensureDb();

    const rows = db
      .query<{ path: string }, []>("SELECT DISTINCT path FROM secrets")
      .all();

    return rows.map((row) => row.path);
  }

  /**
   * Returns all stored paths that are ancestors of (or equal to) the given canonical path.
   * This uses SQL prefix matching for efficient database-level filtering.
   *
   * A path P is considered an ancestor of C if:
   * - P equals C (same directory), or
   * - C starts with P followed by a path separator
   *
   * @param canonicalPath - The canonical path to find ancestors for
   * @returns Array of ancestor paths (unsorted)
   */
  async getAncestorPaths(canonicalPath: string): Promise<string[]> {
    const db = await this.ensureDb();

    // Match paths where:
    // 1. The stored path equals the canonical path exactly, OR
    // 2. The canonical path starts with the stored path followed by a path separator
    // 3. The stored path is the root (special case for drive letters or '/')
    // This prevents partial matches like /home/user matching /home/username
    //
    // On Windows, paths use backslashes and may have drive letters (e.g., C:\Users\...)
    // On Unix, paths use forward slashes and root is '/'
    let rows: { path: string }[];

    if (isWindows()) {
      // Windows: use backslash separator
      // Root paths on Windows are drive letters like "C:\" or "D:\"
      // Match if canonical path equals stored path, or starts with stored path + '\'
      // For drive roots (e.g., "C:\"), check that canonical path starts with the same drive
      rows = db
        .query<{ path: string }, [string, string, string]>(
          "SELECT DISTINCT path FROM secrets WHERE ? = path OR ? LIKE path || '\\' || '%' OR (length(path) = 3 AND path LIKE '_:\\' AND ? LIKE path || '%')"
        )
        .all(canonicalPath, canonicalPath, canonicalPath);
    } else {
      // Unix: use forward slash separator
      rows = db
        .query<{ path: string }, [string, string]>(
          "SELECT DISTINCT path FROM secrets WHERE ? = path OR ? LIKE path || '/' || '%' OR path = '/'"
        )
        .all(canonicalPath, canonicalPath);
    }

    return rows.map((row) => row.path);
  }

  async removeKey(canonicalPath: string, key: string): Promise<boolean> {
    const db = await this.ensureDb();

    const existing = db
      .query<{ path: string }, [string, string]>(
        "SELECT path FROM secrets WHERE path = ? AND key = ?"
      )
      .get(canonicalPath, key);

    if (!existing) {
      return false;
    }

    db.query("DELETE FROM secrets WHERE path = ? AND key = ?").run(
      canonicalPath,
      key
    );

    return true;
  }

  /**
   * Adds a trusted path entry.
   * 
   * @param canonicalPath - The canonical path to trust
   * @param inode - The filesystem inode/file ID for the path
   */
  async addTrustedPath(canonicalPath: string, inode: string): Promise<void> {
    const db = await this.ensureDb();
    const trustedAt = new Date().toISOString();

    db.query(`
      INSERT INTO trusted_paths (path, inode, trusted_at)
      VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        inode = excluded.inode,
        trusted_at = excluded.trusted_at
    `).run(canonicalPath, inode, trustedAt);
  }

  /**
   * Removes a trusted path entry.
   * 
   * @param canonicalPath - The canonical path to untrust
   * @returns true if the path was found and removed, false otherwise
   */
  async removeTrustedPath(canonicalPath: string): Promise<boolean> {
    const db = await this.ensureDb();

    const existing = db
      .query<{ path: string }, [string]>(
        "SELECT path FROM trusted_paths WHERE path = ?"
      )
      .get(canonicalPath);

    if (!existing) {
      return false;
    }

    db.query("DELETE FROM trusted_paths WHERE path = ?").run(canonicalPath);
    return true;
  }

  /**
   * Gets a trusted path entry by its canonical path.
   * 
   * @param canonicalPath - The canonical path to look up
   * @returns The trusted path entry or undefined if not found
   */
  async getTrustedPath(canonicalPath: string): Promise<TrustedPath | undefined> {
    const db = await this.ensureDb();

    const row = db
      .query<{ path: string; inode: string; trusted_at: string }, [string]>(
        "SELECT path, inode, trusted_at FROM trusted_paths WHERE path = ?"
      )
      .get(canonicalPath);

    if (!row) {
      return undefined;
    }

    return {
      path: row.path,
      inode: row.inode,
      trustedAt: row.trusted_at,
    };
  }

  /**
   * Gets all trusted paths.
   * 
   * @returns Array of all trusted path entries
   */
  async getAllTrustedPaths(): Promise<TrustedPath[]> {
    const db = await this.ensureDb();

    const rows = db
      .query<{ path: string; inode: string; trusted_at: string }, []>(
        "SELECT path, inode, trusted_at FROM trusted_paths ORDER BY path"
      )
      .all();

    return rows.map((row) => ({
      path: row.path,
      inode: row.inode,
      trustedAt: row.trusted_at,
    }));
  }

  /**
   * Finds trusted ancestor paths for a given canonical path.
   * Returns all trusted paths that are ancestors of (or equal to) the given path.
   * 
   * @param canonicalPath - The canonical path to check
   * @returns Array of trusted ancestor paths
   */
  async getTrustedAncestorPaths(canonicalPath: string): Promise<TrustedPath[]> {
    const db = await this.ensureDb();

    let rows: { path: string; inode: string; trusted_at: string }[];

    if (isWindows()) {
      rows = db
        .query<{ path: string; inode: string; trusted_at: string }, [string, string, string]>(
          "SELECT path, inode, trusted_at FROM trusted_paths WHERE ? = path OR ? LIKE path || '\\' || '%' OR (length(path) = 3 AND path LIKE '_:\\' AND ? LIKE path || '%')"
        )
        .all(canonicalPath, canonicalPath, canonicalPath);
    } else {
      rows = db
        .query<{ path: string; inode: string; trusted_at: string }, [string, string]>(
          "SELECT path, inode, trusted_at FROM trusted_paths WHERE ? = path OR ? LIKE path || '/' || '%' OR path = '/'"
        )
        .all(canonicalPath, canonicalPath);
    }

    return rows.map((row) => ({
      path: row.path,
      inode: row.inode,
      trustedAt: row.trusted_at,
    }));
  }

  /**
   * Closes the database connection and releases resources.
   * After calling this method, the Storage instance should not be used.
   * 
   * This method is safe to call multiple times.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Allows using the Storage instance with `using` declarations for automatic cleanup.
   * 
   * @example
   * ```typescript
   * {
   *   using storage = new Storage();
   *   await storage.setSecret('/path', 'KEY', 'value');
   * } // storage.close() is called automatically
   * ```
   */
  [Symbol.dispose](): void {
    this.close();
  }
}
