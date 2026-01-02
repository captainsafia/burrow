import { type ResolvedSecret } from "./resolver.ts";

export interface LoadedSecret {
  key: string;
  value: string;
  sourcePath: string;
}

export interface HookDiff {
  /** Keys to unset from the environment */
  toUnset: string[];
  /** Secrets to set in the environment */
  toSet: LoadedSecret[];
}

/**
 * Converts resolved secrets to loaded secrets for the hook.
 */
export function resolveToLoadedSecrets(
  secrets: Map<string, ResolvedSecret>
): LoadedSecret[] {
  const result: LoadedSecret[] = [];
  for (const [, secret] of secrets) {
    result.push({
      key: secret.key,
      value: secret.value,
      sourcePath: secret.sourcePath,
    });
  }
  return result;
}

/**
 * Computes the diff between previously loaded keys and new secrets.
 * 
 * @param previousKeys - Set of keys that were previously loaded
 * @param newSecrets - The newly resolved secrets
 * @returns The diff with keys to unset and secrets to set
 */
export function computeHookDiff(
  previousKeys: Set<string>,
  newSecrets: LoadedSecret[]
): HookDiff {
  const newKeys = new Set(newSecrets.map(s => s.key));
  
  // Keys to unset: were in previous but not in new
  const toUnset: string[] = [];
  for (const key of previousKeys) {
    if (!newKeys.has(key)) {
      toUnset.push(key);
    }
  }
  
  return {
    toUnset,
    toSet: newSecrets,
  };
}

/**
 * Formats a hook result message for display.
 */
export function formatHookMessage(
  diff: HookDiff,
  useColor: boolean = true
): string | undefined {
  const loaded = diff.toSet.length;
  const unloaded = diff.toUnset.length;

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

  // Unset commands first
  for (const key of diff.toUnset) {
    if (shell === "fish") {
      commands.push(`set -e ${key}`);
    } else {
      commands.push(`unset ${key}`);
    }
  }

  // Set commands
  for (const secret of diff.toSet) {
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
