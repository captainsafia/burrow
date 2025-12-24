import type { ResolvedSecret } from "./resolver.ts";

export type ExportFormat = "shell" | "dotenv" | "json";

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key);
}

export function assertValidEnvKey(key: string): void {
  if (!validateEnvKey(key)) {
    throw new Error(
      `Invalid environment variable key: "${key}". ` +
        `Keys must match ${ENV_KEY_PATTERN.toString()}`
    );
  }
}

function escapeShellValue(value: string): string {
  return value.replace(/'/g, "'\"'\"'");
}

function escapeDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function formatShell(secrets: Map<string, ResolvedSecret>): string {
  const lines: string[] = [];
  const sortedKeys = Array.from(secrets.keys()).sort();

  for (const key of sortedKeys) {
    const secret = secrets.get(key)!;
    assertValidEnvKey(key);
    const escapedValue = escapeShellValue(secret.value);
    lines.push(`export ${key}='${escapedValue}'`);
  }

  return lines.join("\n");
}

export function formatDotenv(secrets: Map<string, ResolvedSecret>): string {
  const lines: string[] = [];
  const sortedKeys = Array.from(secrets.keys()).sort();

  for (const key of sortedKeys) {
    const secret = secrets.get(key)!;
    assertValidEnvKey(key);

    if (secret.value.includes("\n")) {
      throw new Error(
        `Cannot export key "${key}" to dotenv format: value contains newlines. ` +
          `Use --format json or --format shell instead.`
      );
    }

    const escapedValue = escapeDoubleQuotes(secret.value);
    lines.push(`${key}="${escapedValue}"`);
  }

  return lines.join("\n");
}

export function formatJson(
  secrets: Map<string, ResolvedSecret>,
  includeSources: boolean = false
): string {
  if (includeSources) {
    const result: Record<string, { value: string; sourcePath: string }> = {};
    for (const [key, secret] of secrets) {
      result[key] = {
        value: secret.value,
        sourcePath: secret.sourcePath,
      };
    }
    return JSON.stringify(result, null, 2);
  } else {
    const result: Record<string, string> = {};
    for (const [key, secret] of secrets) {
      result[key] = secret.value;
    }
    return JSON.stringify(result, null, 2);
  }
}

export function format(
  secrets: Map<string, ResolvedSecret>,
  fmt: ExportFormat,
  options: { includeSources?: boolean } = {}
): string {
  switch (fmt) {
    case "shell":
      return formatShell(secrets);
    case "dotenv":
      return formatDotenv(secrets);
    case "json":
      return formatJson(secrets, options.includeSources);
    default:
      throw new Error(`Unknown format: ${fmt}`);
  }
}
