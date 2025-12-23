import { homedir } from "node:os";
import { join } from "node:path";

const APP_NAME = "burrow";

export function getConfigDir(): string {
  const platform = process.platform;

  if (platform === "win32") {
    return getWindowsConfigDir();
  }

  return getUnixConfigDir();
}

function getUnixConfigDir(): string {
  const xdgConfigHome = process.env["XDG_CONFIG_HOME"];
  if (xdgConfigHome) {
    return join(xdgConfigHome, APP_NAME);
  }

  const home = homedir();
  return join(home, ".config", APP_NAME);
}

function getWindowsConfigDir(): string {
  const appData = process.env["APPDATA"];
  if (appData) {
    return join(appData, APP_NAME);
  }

  const localAppData = process.env["LOCALAPPDATA"];
  if (localAppData) {
    return join(localAppData, APP_NAME);
  }

  const home = homedir();
  return join(home, APP_NAME);
}

export function isWindows(): boolean {
  return process.platform === "win32";
}
