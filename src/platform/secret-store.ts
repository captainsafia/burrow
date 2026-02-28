import { spawn } from "node:child_process";

const SECRET_STORE_TIMEOUT_MS = 10000;
const BURROW_SERVICE_NAME = "burrow.safia.dev";
// `security` returns the lower 8 bits of `errSecItemNotFound` (-25300), which is 44.
const MACOS_ITEM_NOT_FOUND_EXIT_CODE = 44;
const UNIX_FALLBACK_PATH_ENTRIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
  "/snap/bin",
];

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CommandOptions {
  stdin?: string;
  timeoutMs?: number;
}

export interface SecretStore {
  readonly backendName: string;
  getSecret(identifier: string): Promise<string | undefined>;
  setSecret(identifier: string, value: string): Promise<void>;
}

function formatCommandFailure(command: string, error: unknown): Error {
  const maybeErr = error as NodeJS.ErrnoException;
  if (maybeErr.code === "ENOENT") {
    if (command === "secret-tool") {
      return new Error(
        'Required command "secret-tool" is not available. Install libsecret-tools (or libsecret on some distros), ensure it is on PATH, or set BURROW_ENCRYPTION_KEY.'
      );
    }

    return new Error(`Required command "${command}" is not available or not on PATH`);
  }

  return error instanceof Error
    ? error
    : new Error(`Failed to run command "${command}"`);
}

async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };

    if (process.platform !== "win32") {
      const currentPath = env["PATH"] ?? "";
      const pathEntries = currentPath
        .split(":")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      for (const fallbackEntry of UNIX_FALLBACK_PATH_ENTRIES) {
        if (!pathEntries.includes(fallbackEntry)) {
          pathEntries.push(fallbackEntry);
        }
      }

      env["PATH"] = pathEntries.join(":");
    }

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeoutMs = options.timeoutMs ?? SECRET_STORE_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Command timed out: ${command}`));
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: exitCode ?? -1,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

class MacOsKeychainSecretStore implements SecretStore {
  readonly backendName = "macOS Keychain";

  async getSecret(identifier: string): Promise<string | undefined> {
    let result: CommandResult;
    try {
      result = await runCommand("security", [
        "find-generic-password",
        "-s",
        BURROW_SERVICE_NAME,
        "-a",
        identifier,
        "-w",
      ]);
    } catch (error) {
      throw formatCommandFailure("security", error);
    }

    if (result.exitCode === 0) {
      return result.stdout;
    }

    if (result.exitCode === MACOS_ITEM_NOT_FOUND_EXIT_CODE) {
      return undefined;
    }

    throw new Error(
      `Failed to read key from ${this.backendName}: ${result.stderr || `exit code ${result.exitCode}`}`
    );
  }

  async setSecret(identifier: string, value: string): Promise<void> {
    let result: CommandResult;
    try {
      result = await runCommand("security", [
        "add-generic-password",
        "-U",
        "-s",
        BURROW_SERVICE_NAME,
        "-a",
        identifier,
        "-w",
        value,
      ]);
    } catch (error) {
      throw formatCommandFailure("security", error);
    }

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to write key to ${this.backendName}: ${result.stderr || `exit code ${result.exitCode}`}`
      );
    }
  }
}

class LinuxSecretServiceStore implements SecretStore {
  readonly backendName = "Linux Secret Service";

  async getSecret(identifier: string): Promise<string | undefined> {
    let result: CommandResult;
    try {
      result = await runCommand("secret-tool", [
        "lookup",
        "service",
        BURROW_SERVICE_NAME,
        "account",
        identifier,
      ]);
    } catch (error) {
      throw formatCommandFailure("secret-tool", error);
    }

    if (result.exitCode === 0) {
      return result.stdout;
    }

    if (result.exitCode === 1 && result.stderr.length === 0) {
      return undefined;
    }

    throw new Error(
      `Failed to read key from ${this.backendName}: ${result.stderr || `exit code ${result.exitCode}`}`
    );
  }

  async setSecret(identifier: string, value: string): Promise<void> {
    let result: CommandResult;
    try {
      result = await runCommand(
        "secret-tool",
        [
          "store",
          "--label",
          "Burrow encryption key",
          "service",
          BURROW_SERVICE_NAME,
          "account",
          identifier,
        ],
        { stdin: `${value}\n` }
      );
    } catch (error) {
      throw formatCommandFailure("secret-tool", error);
    }

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to write key to ${this.backendName}: ${result.stderr || `exit code ${result.exitCode}`}`
      );
    }
  }
}

function toPowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function runPowerShellScript(script: string): Promise<CommandResult> {
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");

  try {
    return await runCommand("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedScript,
    ]);
  } catch (error) {
    throw formatCommandFailure("powershell", error);
  }
}

class WindowsDpapiSecretStore implements SecretStore {
  readonly backendName = "Windows DPAPI";

  async getSecret(identifier: string): Promise<string | undefined> {
    const identifierLiteral = toPowerShellLiteral(identifier);
    const script = `
$ErrorActionPreference = 'Stop'
$path = 'HKCU:\\Software\\captainsafia\\burrow\\keys'
$name = ${identifierLiteral}
try {
  $encrypted = (Get-ItemProperty -Path $path -Name $name -ErrorAction Stop).$name
  if (-not $encrypted) { exit 3 }
  $bytes = [Convert]::FromBase64String($encrypted)
  $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $bytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plainBytes))
  exit 0
} catch {
  exit 3
}
`;

    const result = await runPowerShellScript(script);
    if (result.exitCode === 0) {
      return result.stdout;
    }

    if (result.exitCode === 3) {
      return undefined;
    }

    throw new Error(
      `Failed to read key from ${this.backendName}: ${result.stderr || `exit code ${result.exitCode}`}`
    );
  }

  async setSecret(identifier: string, value: string): Promise<void> {
    const identifierLiteral = toPowerShellLiteral(identifier);
    const valueLiteral = toPowerShellLiteral(value);
    const script = `
$ErrorActionPreference = 'Stop'
$path = 'HKCU:\\Software\\captainsafia\\burrow\\keys'
$name = ${identifierLiteral}
$secret = ${valueLiteral}
if (-not (Test-Path $path)) {
  New-Item -Path $path -Force | Out-Null
}
$bytes = [System.Text.Encoding]::UTF8.GetBytes($secret)
$encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
  $bytes,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
$encoded = [Convert]::ToBase64String($encrypted)
Set-ItemProperty -Path $path -Name $name -Value $encoded -Force
`;

    const result = await runPowerShellScript(script);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to write key to ${this.backendName}: ${result.stderr || `exit code ${result.exitCode}`}`
      );
    }
  }
}

export function createSystemSecretStore(): SecretStore {
  switch (process.platform) {
    case "darwin":
      return new MacOsKeychainSecretStore();
    case "linux":
      return new LinuxSecretServiceStore();
    case "win32":
      return new WindowsDpapiSecretStore();
    default:
      throw new Error(`Unsupported platform for secret storage: ${process.platform}`);
  }
}
