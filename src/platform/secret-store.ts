import { existsSync } from "node:fs";
import { join } from "node:path";

const BURROW_SERVICE_NAME = "burrow.safia.dev";
const BURROW_ENCRYPTION_KEY_ENV = "BURROW_ENCRYPTION_KEY";
const DBUS_SESSION_BUS_ADDRESS_ENV = "DBUS_SESSION_BUS_ADDRESS";
const XDG_RUNTIME_DIR_ENV = "XDG_RUNTIME_DIR";

export interface SecretStore {
  readonly backendName: string;
  getSecret(identifier: string): Promise<string | undefined>;
  setSecret(identifier: string, value: string): Promise<void>;
}

function resolveBackendName(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS Keychain";
    case "linux":
      return "Linux Secret Service";
    case "win32":
      return "Windows Credential Manager";
    default:
      return "system secret store";
  }
}

function discoverLinuxDbusSessionBusAddress(): string | undefined {
  const xdgRuntimeDir = process.env[XDG_RUNTIME_DIR_ENV]?.trim();
  const candidatePaths: string[] = [];

  if (xdgRuntimeDir) {
    candidatePaths.push(join(xdgRuntimeDir, "bus"));
  }

  if (typeof process.getuid === "function") {
    candidatePaths.push(join("/run/user", String(process.getuid()), "bus"));
  }

  for (const candidatePath of candidatePaths) {
    if (existsSync(candidatePath)) {
      return `unix:path=${candidatePath}`;
    }
  }

  return undefined;
}

function ensureLinuxDbusSessionBusAddress(): void {
  if (process.platform !== "linux") {
    return;
  }

  const currentAddress = process.env[DBUS_SESSION_BUS_ADDRESS_ENV]?.trim();
  if (currentAddress) {
    return;
  }

  const discoveredAddress = discoverLinuxDbusSessionBusAddress();
  if (discoveredAddress) {
    process.env[DBUS_SESSION_BUS_ADDRESS_ENV] = discoveredAddress;
  }
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class BunSecretsStore implements SecretStore {
  readonly backendName = resolveBackendName();

  private buildLinuxGuidance(message: string): string {
    const lowered = message.toLowerCase();

    if (lowered.includes("locked collection")) {
      return (
        `Failed to access encryption key in ${this.backendName}: the keyring collection is locked. ` +
        `Unlock your login keyring and retry, or set ${BURROW_ENCRYPTION_KEY_ENV} for headless usage.`
      );
    }

    if (lowered.includes("dbus") || lowered.includes("autolaunch")) {
      return (
        `Failed to access encryption key in ${this.backendName}: no D-Bus session bus was available. ` +
        `Ensure a user session bus is running (Burrow auto-discovers ${XDG_RUNTIME_DIR_ENV}/bus and /run/user/$UID/bus), ` +
        `or set ${BURROW_ENCRYPTION_KEY_ENV} for headless usage.`
      );
    }

    return `Failed to access encryption key in ${this.backendName}: ${message}`;
  }

  private wrapError(error: unknown): Error {
    const message = normalizeErrorMessage(error);

    if (process.platform === "linux") {
      return new Error(this.buildLinuxGuidance(message));
    }

    return new Error(`Failed to access encryption key in ${this.backendName}: ${message}`);
  }

  async getSecret(identifier: string): Promise<string | undefined> {
    ensureLinuxDbusSessionBusAddress();

    try {
      const value = await Bun.secrets.get({
        service: BURROW_SERVICE_NAME,
        name: identifier,
      });
      return value ?? undefined;
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async setSecret(identifier: string, value: string): Promise<void> {
    ensureLinuxDbusSessionBusAddress();

    try {
      await Bun.secrets.set({
        service: BURROW_SERVICE_NAME,
        name: identifier,
        value,
      });
    } catch (error) {
      throw this.wrapError(error);
    }
  }
}

export function createSystemSecretStore(): SecretStore {
  return new BunSecretsStore();
}
