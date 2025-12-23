import { mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getConfigDir } from "../platform/index.ts";

const STORE_VERSION = 1;
const DEFAULT_STORE_FILE = "store.json";

export interface SecretEntry {
  value: string | null;
  updatedAt: string;
}

export interface PathSecrets {
  [key: string]: SecretEntry;
}

export interface Store {
  version: number;
  paths: {
    [path: string]: PathSecrets;
  };
}

export interface StorageOptions {
  configDir?: string;
  storeFileName?: string;
}

function createEmptyStore(): Store {
  return {
    version: STORE_VERSION,
    paths: {},
  };
}

export class Storage {
  private readonly configDir: string;
  private readonly storeFileName: string;

  constructor(options: StorageOptions = {}) {
    this.configDir = options.configDir ?? getConfigDir();
    this.storeFileName = options.storeFileName ?? DEFAULT_STORE_FILE;
  }

  private get storePath(): string {
    return join(this.configDir, this.storeFileName);
  }

  async read(): Promise<Store> {
    try {
      const file = Bun.file(this.storePath);
      const content = await file.text();
      const store = JSON.parse(content) as Store;

      if (store.version !== STORE_VERSION) {
        throw new Error(
          `Unsupported store version: ${store.version}. Expected: ${STORE_VERSION}`
        );
      }

      return store;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createEmptyStore();
      }
      throw error;
    }
  }

  async write(store: Store): Promise<void> {
    await mkdir(this.configDir, { recursive: true });

    const tempFileName = `.store-${randomBytes(8).toString("hex")}.tmp`;
    const tempPath = join(this.configDir, tempFileName);

    const content = JSON.stringify(store, null, 2);

    try {
      const file = Bun.file(tempPath);
      await Bun.write(file, content);

      await rename(tempPath, this.storePath);
    } catch (error) {
      try {
        await unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  async setSecret(
    canonicalPath: string,
    key: string,
    value: string | null
  ): Promise<void> {
    const store = await this.read();

    if (!store.paths[canonicalPath]) {
      store.paths[canonicalPath] = {};
    }

    store.paths[canonicalPath][key] = {
      value,
      updatedAt: new Date().toISOString(),
    };

    await this.write(store);
  }

  async getPathSecrets(canonicalPath: string): Promise<PathSecrets | undefined> {
    const store = await this.read();
    return store.paths[canonicalPath];
  }

  async getAllPaths(): Promise<string[]> {
    const store = await this.read();
    return Object.keys(store.paths);
  }

  async removeKey(canonicalPath: string, key: string): Promise<boolean> {
    const store = await this.read();

    if (!store.paths[canonicalPath]?.[key]) {
      return false;
    }

    delete store.paths[canonicalPath][key];

    if (Object.keys(store.paths[canonicalPath]).length === 0) {
      delete store.paths[canonicalPath];
    }

    await this.write(store);
    return true;
  }
}
