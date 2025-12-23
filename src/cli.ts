#!/usr/bin/env bun

import { BurrowClient, type ExportFormat } from "./api.ts";

const VERSION = "0.1.0";

function printHelp(): void {
  console.log(`burrow v${VERSION} - Directory-scoped secrets manager

Usage: burrow <command> [options]

Commands:
  set KEY=VALUE [--path <dir>]     Set a secret at the given path (default: cwd)
  get KEY [options]                Get a secret resolved from cwd ancestry
  list [options]                   List all resolved secrets for cwd
  unset KEY [--path <dir>]         Block a key with a tombstone at the given path
  export [options]                 Export resolved secrets in various formats

Options for 'get':
  --show                Show actual value (default: redacted)
  --format plain|json   Output format (default: plain)

Options for 'list':
  --format plain|json   Output format (default: plain)

Options for 'export':
  --format shell|dotenv|json  Export format (default: shell)
  --path <dir>                Directory to resolve from (default: cwd)
  --sources                   Include source paths in json output

Examples:
  burrow set API_KEY=abc123
  burrow set DATABASE_URL=postgres://... --path /projects/myapp
  burrow get API_KEY --show
  burrow list --format json
  burrow unset API_KEY
  eval "$(burrow export --format shell)"
`);
}

function printVersion(): void {
  console.log(`burrow v${VERSION}`);
}

function parseArgs(args: string[]): {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
} {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (!command && !arg.startsWith("-")) {
      command = arg;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];

      if (nextArg && !nextArg.startsWith("-")) {
        flags.set(key, nextArg);
        i++;
      } else {
        flags.set(key, true);
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      flags.set(key, true);
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

function redactValue(value: string): string {
  if (value.length <= 4) {
    return "****";
  }
  return value.slice(0, 2) + "****" + value.slice(-2);
}

async function cmdSet(
  client: BurrowClient,
  positional: string[],
  flags: Map<string, string | boolean>
): Promise<void> {
  if (positional.length === 0) {
    console.error("Error: Missing KEY=VALUE argument");
    process.exit(1);
  }

  const keyValue = positional[0]!;
  const eqIndex = keyValue.indexOf("=");

  if (eqIndex === -1) {
    console.error("Error: Argument must be in KEY=VALUE format");
    process.exit(1);
  }

  const key = keyValue.slice(0, eqIndex);
  const value = keyValue.slice(eqIndex + 1);
  const path = flags.get("path") as string | undefined;

  try {
    await client.set(key, value, { path });
    console.log(`Set ${key} at ${path ?? process.cwd()}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function cmdGet(
  client: BurrowClient,
  positional: string[],
  flags: Map<string, string | boolean>
): Promise<void> {
  if (positional.length === 0) {
    console.error("Error: Missing KEY argument");
    process.exit(1);
  }

  const key = positional[0]!;
  const showValue = flags.get("show") === true;
  const format = (flags.get("format") as string) || "plain";

  try {
    const secret = await client.get(key);

    if (!secret) {
      console.error(`Error: Key "${key}" not found`);
      process.exit(1);
    }

    if (format === "json") {
      console.log(
        JSON.stringify(
          {
            key: secret.key,
            value: showValue ? secret.value : redactValue(secret.value),
            sourcePath: secret.sourcePath,
          },
          null,
          2
        )
      );
    } else {
      if (showValue) {
        console.log(secret.value);
      } else {
        console.log(redactValue(secret.value));
      }
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function cmdList(
  client: BurrowClient,
  _positional: string[],
  flags: Map<string, string | boolean>
): Promise<void> {
  const format = (flags.get("format") as string) || "plain";

  try {
    const secrets = await client.list();

    if (secrets.length === 0) {
      if (format === "plain") {
        console.log("No secrets found for current directory");
      } else {
        console.log("[]");
      }
      return;
    }

    if (format === "json") {
      const output = secrets.map((s) => ({
        key: s.key,
        value: redactValue(s.value),
        sourcePath: s.sourcePath,
      }));
      console.log(JSON.stringify(output, null, 2));
    } else {
      for (const secret of secrets) {
        console.log(`${secret.key} (from ${secret.sourcePath})`);
      }
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function cmdUnset(
  client: BurrowClient,
  positional: string[],
  flags: Map<string, string | boolean>
): Promise<void> {
  if (positional.length === 0) {
    console.error("Error: Missing KEY argument");
    process.exit(1);
  }

  const key = positional[0]!;
  const path = flags.get("path") as string | undefined;

  try {
    await client.block(key, { path });
    console.log(`Unset ${key} at ${path ?? process.cwd()}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function cmdExport(
  client: BurrowClient,
  _positional: string[],
  flags: Map<string, string | boolean>
): Promise<void> {
  const format = (flags.get("format") as ExportFormat) || "shell";
  const path = flags.get("path") as string | undefined;
  const includeSources = flags.get("sources") === true;

  if (!["shell", "dotenv", "json"].includes(format)) {
    console.error(`Error: Invalid format "${format}". Use shell, dotenv, or json.`);
    process.exit(1);
  }

  try {
    const output = await client.export({
      cwd: path,
      format,
      includeSources,
    });
    console.log(output);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    printVersion();
    process.exit(0);
  }

  const { command, positional, flags } = parseArgs(args);
  const client = new BurrowClient();

  switch (command) {
    case "set":
      await cmdSet(client, positional, flags);
      break;
    case "get":
      await cmdGet(client, positional, flags);
      break;
    case "list":
      await cmdList(client, positional, flags);
      break;
    case "unset":
      await cmdUnset(client, positional, flags);
      break;
    case "export":
      await cmdExport(client, positional, flags);
      break;
    default:
      console.error(`Error: Unknown command "${command}"`);
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
