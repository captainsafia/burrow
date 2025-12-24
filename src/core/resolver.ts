import { type Storage } from "../storage/index.ts";
import { canonicalize, type PathOptions } from "./path.ts";
import { isWindows } from "../platform/index.ts";

export interface ResolvedSecret {
  key: string;
  value: string;
  sourcePath: string;
}

export interface ResolverOptions extends PathOptions {
  storage: Storage;
}

export class Resolver {
  private readonly storage: Storage;
  private readonly pathOptions: PathOptions;

  constructor(options: ResolverOptions) {
    this.storage = options.storage;
    this.pathOptions = {
      followSymlinks: options.followSymlinks,
    };
  }

  async resolve(cwd?: string): Promise<Map<string, ResolvedSecret>> {
    const workingDir = cwd ?? process.cwd();
    const canonicalCwd = await canonicalize(workingDir, this.pathOptions);

    const ancestorPaths = await this.storage.getAncestorPaths(canonicalCwd);

    ancestorPaths.sort((a, b) => {
      if (isWindows()) {
        return a.toLowerCase().localeCompare(b.toLowerCase());
      }
      return a.localeCompare(b);
    });

    const resolved = new Map<string, ResolvedSecret>();

    for (const scopePath of ancestorPaths) {
      const secrets = await this.storage.getPathSecrets(scopePath);
      if (!secrets) continue;

      for (const [key, entry] of Object.entries(secrets)) {
        if (entry.value === null) {
          resolved.delete(key);
        } else {
          resolved.set(key, {
            key,
            value: entry.value,
            sourcePath: scopePath,
          });
        }
      }
    }

    return resolved;
  }

  async get(
    key: string,
    cwd?: string
  ): Promise<ResolvedSecret | undefined> {
    const resolved = await this.resolve(cwd);
    return resolved.get(key);
  }

  async list(cwd?: string): Promise<ResolvedSecret[]> {
    const resolved = await this.resolve(cwd);
    return Array.from(resolved.values()).sort((a, b) =>
      a.key.localeCompare(b.key)
    );
  }

  get storageInstance(): Storage {
    return this.storage;
  }
}
