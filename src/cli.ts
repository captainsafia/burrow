#!/usr/bin/env bun

import { Command } from "commander";
import { BurrowClient, type ExportFormat } from "./api.ts";

const VERSION = "0.1.0";

function redactValue(value: string): string {
  if (value.length <= 4) {
    return "****";
  }
  return value.slice(0, 2) + "****" + value.slice(-2);
}

const program = new Command();

program
  .name("burrow")
  .description("Directory-scoped secrets manager")
  .version(VERSION);

program
  .command("set")
  .description("Set a secret at the given path")
  .argument("<key=value>", "Secret in KEY=VALUE format")
  .option("-p, --path <dir>", "Directory to scope the secret to (default: cwd)")
  .action(async (keyValue: string, options: { path?: string }) => {
    const client = new BurrowClient();
    const eqIndex = keyValue.indexOf("=");

    if (eqIndex === -1) {
      console.error("Error: Argument must be in KEY=VALUE format");
      process.exit(1);
    }

    const key = keyValue.slice(0, eqIndex);
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
  .option("-s, --show", "Show actual value (default: redacted)")
  .option("-f, --format <format>", "Output format: plain, json", "plain")
  .action(async (key: string, options: { show?: boolean; format: string }) => {
    const client = new BurrowClient();

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
              value: options.show ? secret.value : redactValue(secret.value),
              sourcePath: secret.sourcePath,
            },
            null,
            2
          )
        );
      } else {
        if (options.show) {
          console.log(secret.value);
        } else {
          console.log(redactValue(secret.value));
        }
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List all resolved secrets for cwd")
  .option("-f, --format <format>", "Output format: plain, json", "plain")
  .action(async (options: { format: string }) => {
    const client = new BurrowClient();

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
  });

program
  .command("unset")
  .description("Block a key with a tombstone (prevents inheritance)")
  .argument("<key>", "Secret key to block")
  .option("-p, --path <dir>", "Directory to scope the tombstone to (default: cwd)")
  .action(async (key: string, options: { path?: string }) => {
    const client = new BurrowClient();

    try {
      await client.block(key, { path: options.path });
      console.log(`Unset ${key} at ${options.path ?? process.cwd()}`);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("export")
  .description("Export resolved secrets in various formats")
  .option("-f, --format <format>", "Export format: shell, dotenv, json", "shell")
  .option("-p, --path <dir>", "Directory to resolve from (default: cwd)")
  .option("--sources", "Include source paths in json output")
  .action(async (options: { format: string; path?: string; sources?: boolean }) => {
    const client = new BurrowClient();
    const format = options.format as ExportFormat;

    if (!["shell", "dotenv", "json"].includes(format)) {
      console.error(`Error: Invalid format "${format}". Use shell, dotenv, or json.`);
      process.exit(1);
    }

    try {
      const output = await client.export({
        cwd: options.path,
        format,
        includeSources: options.sources,
      });
      console.log(output);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parse();
