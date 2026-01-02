import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir } from "../platform/index.ts";
import { type ResolvedSecret } from "./resolver.ts";

const HOOK_STATE_FILE = "hook-state.json";

export interface LoadedSecret {
  key: string;
  value: string;
  sourcePath: string;
}

export interface HookState {
  /** Currently loaded secret keys and their values */
  secrets: LoadedSecret[];
  /** The last directory that triggered loading */
  lastDir: string;
  /** Timestamp when secrets were loaded */
  loadedAt: string;
  /** Keys that were skipped due to conflicts */
  skippedKeys: string[];
}

export interface HookDiff {
  /** Keys to unset from the environment */
  unset: string[];
  /** Secrets to set in the environment */
  set: LoadedSecret[];
  /** Keys that already exist in the environment and were skipped */
  skipped: string[];
  /** Keys that remain unchanged */
  unchanged: string[];
}

export interface HookOptions {
  configDir?: string;
}

/**
 * Manages hook state for direnv-style auto-loading.
 */
export class HookStateManager {
  private readonly configDir: string;
  private readonly stateFilePath: string;

  constructor(options: HookOptions = {}) {
    this.configDir = options.configDir ?? getConfigDir();
    this.stateFilePath = join(this.configDir, HOOK_STATE_FILE);
  }

  /**
   * Loads the current hook state from disk.
   * Returns undefined if no state file exists.
   */
  async load(): Promise<HookState | undefined> {
    try {
      const content = await readFile(this.stateFilePath, "utf-8");
      return JSON.parse(content) as HookState;
    } catch {
      return undefined;
    }
  }

  /**
   * Saves the hook state to disk.
   */
  async save(state: HookState): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    await writeFile(this.stateFilePath, JSON.stringify(state, null, 2));
  }

  /**
   * Clears the hook state file.
   */
  async clear(): Promise<void> {
    try {
      await rm(this.stateFilePath, { force: true });
    } catch {
      // Ignore errors if file doesn't exist
    }
  }

  /**
   * Computes the diff between currently loaded secrets and new secrets.
   * Takes into account existing environment variables to avoid conflicts.
   * 
   * @param currentState - The currently loaded state (or undefined if none)
   * @param newSecrets - The newly resolved secrets
   * @param env - Current environment variables to check for conflicts
   * @returns The diff of what to set, unset, and skip
   */
  computeDiff(
    currentState: HookState | undefined,
    newSecrets: Map<string, ResolvedSecret>,
    env: Record<string, string | undefined> = process.env
  ): HookDiff {
    const currentKeys = new Map<string, LoadedSecret>();
    if (currentState) {
      for (const secret of currentState.secrets) {
        currentKeys.set(secret.key, secret);
      }
    }

    const skippedFromState = new Set(currentState?.skippedKeys ?? []);

    const unset: string[] = [];
    const set: LoadedSecret[] = [];
    const skipped: string[] = [];
    const unchanged: string[] = [];

    // Check what needs to be unset (was loaded but not in new set)
    for (const [key] of currentKeys) {
      if (!newSecrets.has(key)) {
        unset.push(key);
      }
    }

    // Check what needs to be set or skipped
    for (const [key, secret] of newSecrets) {
      const loadedSecret: LoadedSecret = {
        key: secret.key,
        value: secret.value,
        sourcePath: secret.sourcePath,
      };

      const current = currentKeys.get(key);
      
      if (current) {
        // Key was already loaded by us
        if (current.value === secret.value && current.sourcePath === secret.sourcePath) {
          // Same value and source - unchanged
          unchanged.push(key);
        } else {
          // Value or source changed - update it
          set.push(loadedSecret);
        }
      } else {
        // Key was not loaded by us - check for conflicts
        const envValue = env[key];
        if (envValue !== undefined && !skippedFromState.has(key)) {
          // Environment already has this key and we didn't skip it before
          skipped.push(key);
        } else {
          // Safe to set
          set.push(loadedSecret);
        }
      }
    }

    return { unset, set, skipped, unchanged };
  }

  /**
   * Applies a diff and updates the state file.
   * Returns the new state.
   */
  async applyDiff(
    currentState: HookState | undefined,
    diff: HookDiff,
    newDir: string
  ): Promise<HookState> {
    // Build the new secrets list from what remains plus new sets
    const secretsMap = new Map<string, LoadedSecret>();
    
    // Start with current secrets that aren't being unset
    if (currentState) {
      for (const secret of currentState.secrets) {
        if (!diff.unset.includes(secret.key)) {
          secretsMap.set(secret.key, secret);
        }
      }
    }

    // Add/update with new secrets
    for (const secret of diff.set) {
      secretsMap.set(secret.key, secret);
    }

    // Build skipped keys list
    const skippedKeys = [...(currentState?.skippedKeys ?? [])];
    for (const key of diff.skipped) {
      if (!skippedKeys.includes(key)) {
        skippedKeys.push(key);
      }
    }

    const newState: HookState = {
      secrets: Array.from(secretsMap.values()),
      lastDir: newDir,
      loadedAt: new Date().toISOString(),
      skippedKeys,
    };

    await this.save(newState);
    return newState;
  }
}

/**
 * Formats a hook result message for display.
 */
export function formatHookMessage(
  diff: HookDiff,
  useColor: boolean = true
): string | undefined {
  const loaded = diff.set.length;
  const unloaded = diff.unset.length;
  const skippedCount = diff.skipped.length;

  if (loaded === 0 && unloaded === 0) {
    return undefined;
  }

  const dim = useColor ? "\x1b[2m" : "";
  const reset = useColor ? "\x1b[0m" : "";

  let message = `${dim}burrow: `;

  if (unloaded > 0 && loaded > 0) {
    message += `unloaded ${unloaded}, loaded ${loaded}`;
  } else if (loaded > 0) {
    message += `loaded ${loaded} secret${loaded === 1 ? "" : "s"}`;
  } else {
    message += `unloaded ${unloaded} secret${unloaded === 1 ? "" : "s"}`;
  }

  if (skippedCount > 0) {
    message += ` (${skippedCount} skipped)`;
  }

  message += reset;

  return message;
}

/**
 * Generates shell commands to apply a diff.
 */
export function generateShellCommands(
  diff: HookDiff,
  shell: "bash" | "zsh" | "fish"
): string[] {
  const commands: string[] = [];

  // Unset commands
  for (const key of diff.unset) {
    if (shell === "fish") {
      commands.push(`set -e ${key}`);
    } else {
      commands.push(`unset ${key}`);
    }
  }

  // Set commands
  for (const secret of diff.set) {
    const escapedValue = escapeShellValue(secret.value, shell);
    if (shell === "fish") {
      commands.push(`set -gx ${secret.key} ${escapedValue}`);
    } else {
      commands.push(`export ${secret.key}=${escapedValue}`);
    }
  }

  return commands;
}

/**
 * Escapes a value for safe use in shell commands.
 */
function escapeShellValue(value: string, shell: "bash" | "zsh" | "fish"): string {
  if (shell === "fish") {
    // Fish uses single quotes, escape single quotes by ending quote, adding escaped quote, starting quote
    return `'${value.replace(/'/g, "'\"'\"'")}'`;
  } else {
    // Bash/Zsh: use $'...' syntax for proper escaping
    // Escape backslashes, single quotes, and control characters
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `$'${escaped}'`;
  }
}
