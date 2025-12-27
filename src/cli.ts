#!/usr/bin/env bun

import { Command, Option } from "commander";
import { BurrowClient, type ExportFormat } from "./api.ts";
import clipboardy from "clipboardy";

// Read version from package.json at build time
const packageJson = await import("../package.json");

function validatePath(value: string): string {
  if (value.trim() === "") {
    throw new Error("Path cannot be empty");
  }
  return value;
}

const program = new Command();

program
  .name("burrow")
  .description("Directory-scoped secrets manager")
  .version(packageJson.version);

program
  .command("set")
  .description("Set a secret at the given path")
  .argument("<key=value>", "Secret in KEY=VALUE format")
  .option("-p, --path <dir>", "Directory to scope the secret to (default: cwd)", validatePath)
  .action(async (keyValue: string, options: { path?: string }) => {
    using client = new BurrowClient();
    const eqIndex = keyValue.indexOf("=");

    if (eqIndex === -1) {
      console.error("Error: Argument must be in KEY=VALUE format");
      process.exit(1);
    }

    const key = keyValue.slice(0, eqIndex);
    if (key.trim() === "") {
      console.error("Error: Key cannot be empty");
      process.exit(1);
    }
    const value = keyValue.slice(eqIndex + 1);

    try {
      await client.set(key, value, { path: options.path });
      console.log(`Set ${key} at ${options.path ?? process.cwd()}`);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("get")
  .description("Get a secret resolved from cwd ancestry")
  .argument("<key>", "Secret key to retrieve")
  .addOption(new Option("-f, --format <format>", "Output format").choices(["plain", "json"]).default("plain"))
  .action(async (key: string, options: { format: string }) => {
    using client = new BurrowClient();

    try {
      const secret = await client.get(key);

      if (!secret) {
        console.error(`Error: Key "${key}" not found`);
        process.exit(1);
      }

      if (options.format === "json") {
        console.log(
          JSON.stringify(
            {
              key: secret.key,
              value: secret.value,
              sourcePath: secret.sourcePath,
            },
            null,
            2
          )
        );
      } else {
        console.log(secret.value);
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List all resolved secrets for cwd")
  .addOption(new Option("-f, --format <format>", "Output format").choices(["plain", "json"]).default("plain"))
  .action(async (options: { format: string }) => {
    using client = new BurrowClient();

    try {
      const secrets = await client.list();

      if (secrets.length === 0) {
        if (options.format === "plain") {
          console.log("No secrets found for current directory");
        } else {
          console.log("[]");
        }
        return;
      }

      if (options.format === "json") {
        const output = secrets.map((s) => ({
          key: s.key,
          value: s.value,
          sourcePath: s.sourcePath,
        }));
        console.log(JSON.stringify(output, null, 2));
      } else {
        for (const secret of secrets) {
          console.log(`${secret.key}=${secret.value} (from ${secret.sourcePath})`);
        }
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("unset")
  .description("Block a key with a tombstone (prevents inheritance)")
  .argument("<key>", "Secret key to block")
  .option("-p, --path <dir>", "Directory to scope the tombstone to (default: cwd)", validatePath)
  .action(async (key: string, options: { path?: string }) => {
    using client = new BurrowClient();

    try {
      await client.block(key, { path: options.path });
      console.log(`Unset ${key} at ${options.path ?? process.cwd()}`);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("remove")
  .description("Remove a secret entry entirely from the given path")
  .argument("<key>", "Secret key to remove")
  .option("-p, --path <dir>", "Directory to remove the secret from (default: cwd)", validatePath)
  .action(async (key: string, options: { path?: string }) => {
    using client = new BurrowClient();

    try {
      const removed = await client.remove(key, { path: options.path });
      if (removed) {
        console.log(`Removed ${key} from ${options.path ?? process.cwd()}`);
      } else {
        console.log(`Key "${key}" not found at ${options.path ?? process.cwd()}`);
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

function detectShell(): ExportFormat {
  // Check SHELL environment variable (Unix-like systems)
  const shell = process.env["SHELL"] ?? "";
  const shellBase = shell.split("/").pop() ?? "";

  // Check for PowerShell-specific environment variables
  if (process.env["PSModulePath"]) {
    return "powershell";
  }

  // Check for cmd.exe (Windows without PowerShell)
  if (process.env["ComSpec"] && !process.env["SHELL"] && !process.env["PSModulePath"]) {
    // On Windows cmd.exe, SHELL is typically not set
    const comspec = process.env["ComSpec"].toLowerCase();
    if (comspec.includes("cmd.exe")) {
      return "cmd";
    }
  }

  // Match common shell names
  switch (shellBase) {
    case "fish":
      return "fish";
    case "bash":
    case "zsh":
    case "sh":
    case "dash":
    case "ksh":
      return "bash";
    case "pwsh":
    case "powershell":
      return "powershell";
    default:
      // Default to POSIX shell syntax
      return "bash";
  }
}

program
  .command("export")
  .description("Export resolved secrets in various formats")
  .addOption(new Option("-f, --format <format>", "Export format (shell auto-detects your shell)").choices(["shell", "bash", "fish", "powershell", "cmd", "dotenv", "json"]).default("shell"))
  .option("-p, --path <dir>", "Directory to resolve from (default: cwd)", validatePath)
  .option("--sources", "Include source paths in json output")
  .option("--copy", "Copy the output to clipboard")
  .action(async (options: { format: string; path?: string; sources?: boolean; copy?: boolean }) => {
    using client = new BurrowClient();
    let format: ExportFormat;

    if (options.format === "shell") {
      // Auto-detect shell when using the default "shell" format
      format = detectShell();
    } else {
      format = options.format as ExportFormat;
    }

    try {
      const output = await client.export({
        cwd: options.path,
        format,
        includeSources: options.sources,
      });
      console.log(output);

      if (options.copy) {
        await clipboardy.write(output);
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parse();
