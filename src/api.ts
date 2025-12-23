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

export interface BurrowClientOptions {
  configDir?: string;
  storeFileName?: string;
  followSymlinks?: boolean;
}

export interface SetOptions {
  path?: string;
}

export interface GetOptions {
  cwd?: string;
}

export interface ListOptions {
  cwd?: string;
}

export interface BlockOptions {
  path?: string;
}

export interface ExportOptions {
  cwd?: string;
  format?: ExportFormat;
  showValues?: boolean;
  includeSources?: boolean;
}

export class BurrowClient {
  private readonly storage: Storage;
  private readonly resolver: Resolver;
  private readonly pathOptions: PathOptions;

  constructor(options: BurrowClientOptions = {}) {
    this.storage = new Storage({
      configDir: options.configDir,
      storeFileName: options.storeFileName,
    });
    this.resolver = new Resolver({
      configDir: options.configDir,
      storeFileName: options.storeFileName,
      followSymlinks: options.followSymlinks,
    });
    this.pathOptions = {
      followSymlinks: options.followSymlinks,
    };
  }

  async set(key: string, value: string, options: SetOptions = {}): Promise<void> {
    assertValidEnvKey(key);

    const targetPath = options.path ?? process.cwd();
    const canonicalPath = await canonicalize(targetPath, this.pathOptions);

    await this.storage.setSecret(canonicalPath, key, value);
  }

  async get(key: string, options: GetOptions = {}): Promise<ResolvedSecret | undefined> {
    return this.resolver.get(key, options.cwd);
  }

  async list(options: ListOptions = {}): Promise<ResolvedSecret[]> {
    return this.resolver.list(options.cwd);
  }

  async block(key: string, options: BlockOptions = {}): Promise<void> {
    assertValidEnvKey(key);

    const targetPath = options.path ?? process.cwd();
    const canonicalPath = await canonicalize(targetPath, this.pathOptions);

    await this.storage.setSecret(canonicalPath, key, null);
  }

  async export(options: ExportOptions = {}): Promise<string> {
    const secrets = await this.resolver.resolve(options.cwd);
    const fmt = options.format ?? "shell";

    return format(secrets, fmt, {
      includeSources: options.includeSources,
    });
  }

  async resolve(cwd?: string): Promise<Map<string, ResolvedSecret>> {
    return this.resolver.resolve(cwd);
  }
}

export function createClient(options?: BurrowClientOptions): BurrowClient {
  return new BurrowClient(options);
}
