#!/usr/bin/env bun

import { Command, Option } from "commander";
import { BurrowClient, type ExportFormat } from "./api.ts";
import clipboardy from "clipboardy";
import { ReleaseNotifier } from "gh-release-update-notifier";
import { spawn } from "child_process";
import { platform } from "os";
import { join } from "path";
import { getConfigDir } from "./platform/index.ts";

// Read version from package.json at build time
const packageJson = await import("../package.json");

// GitHub repo for update checks
const GITHUB_REPO = "captainsafia/burrow";

// Create release notifier with 1 hour check interval and cache in config dir
const notifier = new ReleaseNotifier({
  repo: GITHUB_REPO,
  checkInterval: 3600000, // 1 hour
  cacheFilePath: join(getConfigDir(), "update-check-cache.json"),
});

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
  .option("--redact", "Redact the secret value in output")
  .action(async (key: string, options: { format: string; redact?: boolean }) => {
    using client = new BurrowClient();

    try {
      const secret = await client.get(key);

      if (!secret) {
        console.error(`Error: Key "${key}" not found`);
        process.exit(1);
      }

      const displayValue = options.redact ? "[REDACTED]" : secret.value;

      if (options.format === "json") {
        console.log(
          JSON.stringify(
            {
              key: secret.key,
              value: displayValue,
              sourcePath: secret.sourcePath,
            },
            null,
            2
          )
        );
      } else {
        console.log(displayValue);
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
  .option("--redact", "Redact the secret values in output")
  .action(async (options: { format: string; redact?: boolean }) => {
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
          value: options.redact ? "[REDACTED]" : s.value,
          sourcePath: s.sourcePath,
        }));
        console.log(JSON.stringify(output, null, 2));
      } else {
        for (const secret of secrets) {
          const displayValue = options.redact ? "[REDACTED]" : secret.value;
          console.log(`${secret.key}=${displayValue} (from ${secret.sourcePath})`);
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
        try {
          await clipboardy.write(output);
        } catch (clipboardError) {
          // Clipboard operation failed, but output was still displayed
          // This is expected in headless environments or when clipboard tools are unavailable
          console.error("Warning: Could not copy to clipboard");
        }
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("update")
  .description("Update burrow to the latest or a specific version")
  .argument("[version]", "Target version to install (e.g., v1.2.0)")
  .option("--check", "Only check for updates without installing")
  .option("--preview", "Update to the latest preview/pre-release version")
  .action(async (version: string | undefined, options: { check?: boolean; preview?: boolean }) => {
    const currentVersion = packageJson.version;
    const isPrerelease = currentVersion.includes("-");

    try {
      if (options.check) {
        // Just check for updates
        const result = await notifier.checkVersion(currentVersion, isPrerelease);

        if (result.updateAvailable) {
          console.log(`Update available: ${currentVersion} → ${result.latestVersion}`);
          console.log(`Run 'burrow update' to install the latest version`);
        } else {
          console.log(`You're on the latest version (${currentVersion})`);
        }
        return;
      }

      // Determine target version
      let targetVersion: string | undefined = version;

      if (!targetVersion) {
        // No version specified, check for latest
        if (options.preview) {
          const release = await notifier.getLatestPrerelease();
          if (release) {
            targetVersion = release.tagName;
          } else {
            console.error("Error: No preview releases available");
            process.exit(1);
          }
        } else {
          const release = await notifier.getLatestRelease();
          if (release) {
            targetVersion = release.tagName;
          } else {
            console.error("Error: No releases available");
            process.exit(1);
          }
        }
      }

      // Normalize version (ensure it starts with 'v')
      if (!targetVersion.startsWith("v")) {
        targetVersion = `v${targetVersion}`;
      }

      // Check if already on this version
      const normalizedCurrent = currentVersion.startsWith("v") ? currentVersion : `v${currentVersion}`;
      if (targetVersion === normalizedCurrent) {
        console.log(`Already on version ${currentVersion}`);
        return;
      }

      console.log(`Updating burrow: ${currentVersion} → ${targetVersion}`);

      // Run the install script with the target version
      const installUrl = "https://safia.rocks/burrow/install.sh";
      const isWindows = platform() === "win32";

      if (isWindows) {
        // On Windows, use PowerShell to run curl and sh (via WSL or Git Bash)
        console.error("Error: Automatic updates are not supported on Windows.");
        console.error(`Please download the new version manually from:`);
        console.error(`  https://github.com/${GITHUB_REPO}/releases/tag/${targetVersion}`);
        process.exit(1);
      }

      const args = options.preview ? ["--preview"] : [targetVersion];
      const curlCmd = `curl -fsSL ${installUrl} | sh -s -- ${args.join(" ")}`;

      const child = spawn("sh", ["-c", curlCmd], {
        stdio: "inherit",
      });

      child.on("close", (code) => {
        if (code === 0) {
          console.log(`\nSuccessfully updated to ${targetVersion}`);
        } else {
          console.error(`\nUpdate failed with exit code ${code}`);
          process.exit(code ?? 1);
        }
      });

      child.on("error", (err) => {
        console.error(`Error running update: ${err.message}`);
        process.exit(1);
      });
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Check for updates after command execution (non-blocking)
async function checkForUpdates(): Promise<void> {
  try {
    const currentVersion = packageJson.version;
    const isPrerelease = currentVersion.includes("-");
    const result = await notifier.checkVersion(currentVersion, isPrerelease);

    if (result.updateAvailable) {
      console.error("");
      console.error(`Update available: ${currentVersion} → ${result.latestVersion}`);
      console.error(`Run 'burrow update ${result.latestVersion}' to install the latest version`);
    }
  } catch {
    // Silently ignore update check errors
  }
}

// Parse arguments and run update check after command completes
async function main(): Promise<void> {
  await program.parseAsync();

  // Run update check after command execution (except for 'update' command itself)
  const command = process.argv[2];
  if (command !== "update" && command !== "--version" && command !== "-V" && command !== "--help" && command !== "-h") {
    await checkForUpdates();
  }
}

main();
