import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir } from "../platform/index.ts";
import { isWindows } from "../platform/index.ts";

const DEFAULT_STORE_FILE = "store.db";
const ENCRYPTION_KEY_ENV = "BURROW_ENCRYPTION_KEY";
const ENCRYPTION_KEY_SERVICE_NAME = "burrow.safia.dev";
const DBUS_SESSION_BUS_ADDRESS_ENV = "DBUS_SESSION_BUS_ADDRESS";
const XDG_RUNTIME_DIR_ENV = "XDG_RUNTIME_DIR";
const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY_LENGTH_BYTES = 32;
const ENCRYPTION_IV_LENGTH_BYTES = 12;
const ENCRYPTION_AUTH_TAG_LENGTH_BYTES = 16;
const CURRENT_STORE_VERSION = 2;

function resolveSecretStoreBackendName(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS Keychain";
    case "linux":
      return "Linux Secret Service";
    case "win32":
      return "Windows Credential Manager";
    default:
      return "system secret store";
  }
}

function discoverLinuxDbusSessionBusAddress(): string | undefined {
  const xdgRuntimeDir = process.env[XDG_RUNTIME_DIR_ENV]?.trim();
  const candidatePaths: string[] = [];

  if (xdgRuntimeDir) {
    candidatePaths.push(join(xdgRuntimeDir, "bus"));
  }

  if (typeof process.getuid === "function") {
    candidatePaths.push(join("/run/user", String(process.getuid()), "bus"));
  }

  for (const candidatePath of candidatePaths) {
    if (existsSync(candidatePath)) {
      return `unix:path=${candidatePath}`;
    }
  }

  return undefined;
}

function ensureLinuxDbusSessionBusAddress(): void {
  if (process.platform !== "linux") {
    return;
  }

  const currentAddress = process.env[DBUS_SESSION_BUS_ADDRESS_ENV]?.trim();
  if (currentAddress) {
    return;
  }

  const discoveredAddress = discoverLinuxDbusSessionBusAddress();
  if (discoveredAddress) {
    process.env[DBUS_SESSION_BUS_ADDRESS_ENV] = discoveredAddress;
  }
}

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
  private readonly keyIdentifier: string;
  private db: Database | null = null;
  private encryptionKey: Buffer | null = null;

  constructor(options: StorageOptions = {}) {
    this.configDir = options.configDir ?? getConfigDir();
    this.storeFileName = options.storeFileName ?? DEFAULT_STORE_FILE;
    this.keyIdentifier = createHash("sha256")
      .update(`${this.configDir}:${this.storeFileName}`)
      .digest("hex");
  }

  private get storePath(): string {
    return join(this.configDir, this.storeFileName);
  }

  private parseStoredKey(content: string): Buffer {
    const trimmed = content.trim();
    if (!/^[a-fA-F0-9]{64}$/.test(trimmed)) {
      throw new Error("Invalid encryption key format");
    }
    return Buffer.from(trimmed, "hex");
  }

  private parseEnvEncryptionKey(envValue: string): Buffer {
    const trimmed = envValue.trim();

    if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
      return Buffer.from(trimmed, "hex");
    }

    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === ENCRYPTION_KEY_LENGTH_BYTES) {
      return decoded;
    }

    throw new Error(
      `Invalid ${ENCRYPTION_KEY_ENV} value. Expected 64-char hex or base64-encoded 32-byte key.`
    );
  }

  private async ensureEncryptionKey(): Promise<Buffer> {
    if (this.encryptionKey) {
      return this.encryptionKey;
    }

    const envKey = process.env[ENCRYPTION_KEY_ENV];
    if (envKey) {
      this.encryptionKey = this.parseEnvEncryptionKey(envKey);
      return this.encryptionKey;
    }

    ensureLinuxDbusSessionBusAddress();

    try {
      const existingKey = await Bun.secrets.get({
        service: ENCRYPTION_KEY_SERVICE_NAME,
        name: this.keyIdentifier,
      });
      if (existingKey !== null) {
        this.encryptionKey = this.parseStoredKey(existingKey);
        return this.encryptionKey;
      }

      const generatedKey = randomBytes(ENCRYPTION_KEY_LENGTH_BYTES);
      await Bun.secrets.set({
        service: ENCRYPTION_KEY_SERVICE_NAME,
        name: this.keyIdentifier,
        value: generatedKey.toString("hex"),
      });
      this.encryptionKey = generatedKey;
      return generatedKey;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to access encryption key in ${resolveSecretStoreBackendName()}: ${message}. ` +
          `Set ${ENCRYPTION_KEY_ENV} to a 32-byte key as fallback.`
      );
    }
  }

  private encryptValue(value: string, key: Buffer): string {
    const iv = randomBytes(ENCRYPTION_IV_LENGTH_BYTES);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, authTag, ciphertext]).toString("base64");
    return `${ENCRYPTED_VALUE_PREFIX}${payload}`;
  }

  private decryptValue(value: string, key: Buffer): string {
    const payload = Buffer.from(value.slice(ENCRYPTED_VALUE_PREFIX.length), "base64");
    if (payload.length < ENCRYPTION_IV_LENGTH_BYTES + ENCRYPTION_AUTH_TAG_LENGTH_BYTES) {
      throw new Error("Encrypted secret payload is corrupted");
    }

    const iv = payload.subarray(0, ENCRYPTION_IV_LENGTH_BYTES);
    const authTag = payload.subarray(
      ENCRYPTION_IV_LENGTH_BYTES,
      ENCRYPTION_IV_LENGTH_BYTES + ENCRYPTION_AUTH_TAG_LENGTH_BYTES
    );
    const ciphertext = payload.subarray(
      ENCRYPTION_IV_LENGTH_BYTES + ENCRYPTION_AUTH_TAG_LENGTH_BYTES
    );

    try {
      const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error(
        "Failed to decrypt a stored secret. The encryption key may be missing or mismatched."
      );
    }
  }

  private async migrateV1SecretsToEncrypted(db: Database): Promise<void> {
    const rows = db
      .query<{ path: string; key: string; value: string }, []>(
        "SELECT path, key, value FROM secrets WHERE value IS NOT NULL"
      )
      .all();

    if (rows.length === 0) {
      return;
    }

    const encryptionKey = await this.ensureEncryptionKey();
    const updateStatement = db.query(
      "UPDATE secrets SET value = ? WHERE path = ? AND key = ?"
    );

    db.run("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (row.value.startsWith(ENCRYPTED_VALUE_PREFIX)) {
          continue;
        }

        const encryptedValue = this.encryptValue(row.value, encryptionKey);
        updateStatement.run(encryptedValue, row.path, row.key);
      }
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
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
      this.db.run(`PRAGMA user_version = ${CURRENT_STORE_VERSION}`);
    } else if (currentVersion === 1) {
      await this.migrateV1SecretsToEncrypted(this.db);
      this.db.run(`PRAGMA user_version = ${CURRENT_STORE_VERSION}`);
    } else if (currentVersion !== CURRENT_STORE_VERSION) {
      throw new Error(
        `Unsupported store version: ${currentVersion}. Expected: ${CURRENT_STORE_VERSION}`
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
    const encryptedValue =
      value === null ? null : this.encryptValue(value, await this.ensureEncryptionKey());

    db.query(`
      INSERT INTO secrets (path, key, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(canonicalPath, key, encryptedValue, updatedAt);
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

    const hasEncryptedRows = rows.some(
      (row) => row.value !== null && row.value.startsWith(ENCRYPTED_VALUE_PREFIX)
    );
    const encryptionKey = hasEncryptedRows ? await this.ensureEncryptionKey() : null;

    const secrets: PathSecrets = {};
    for (const row of rows) {
      const value =
        row.value === null
          ? null
          : row.value.startsWith(ENCRYPTED_VALUE_PREFIX)
            ? this.decryptValue(row.value, encryptionKey!)
            : row.value;

      secrets[row.key] = {
        value,
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
    this.encryptionKey = null;
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
