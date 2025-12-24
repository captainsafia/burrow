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
    this.db.run("PRAGMA journal_mode = WAL");

    // Set restrictive permissions on database file (Unix only)
    if (!isWindows()) {
      await chmod(this.storePath, 0o600);
    }

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
}
