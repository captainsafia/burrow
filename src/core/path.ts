import { realpath } from "node:fs/promises";
import { resolve, sep, normalize } from "node:path";
import { isWindows } from "../platform/index.ts";

export interface PathOptions {
  followSymlinks?: boolean;
}

export async function canonicalize(
  inputPath: string,
  options: PathOptions = {}
): Promise<string> {
  const { followSymlinks = true } = options;

  let canonical: string;

  if (followSymlinks) {
    try {
      canonical = await realpath(inputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        canonical = resolve(inputPath);
      } else {
        throw error;
      }
    }
  } else {
    canonical = resolve(inputPath);
  }

  if (isWindows()) {
    canonical = normalizePath(canonical);
  }

  return canonical;
}

export function normalizePath(path: string): string {
  let normalized = normalize(path);

  if (isWindows()) {
    normalized = normalized.replace(/\//g, "\\");

    if (normalized.length >= 2 && normalized[1] === ":") {
      normalized = normalized[0]!.toUpperCase() + normalized.slice(1);
    }
  }

  return normalized;
}

export function getAncestors(canonicalPath: string): string[] {
  const ancestors: string[] = [];
  let current = canonicalPath;

  while (true) {
    ancestors.push(current);
    const parent = getParentPath(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  return ancestors.reverse();
}

function getParentPath(path: string): string {
  if (isWindows()) {
    if (path.match(/^[A-Z]:\\?$/i)) {
      return path;
    }

    const lastSep = path.lastIndexOf(sep);
    if (lastSep <= 2) {
      return path.slice(0, 3);
    }
    return path.slice(0, lastSep);
  } else {
    if (path === "/") {
      return "/";
    }

    const lastSep = path.lastIndexOf(sep);
    if (lastSep === 0) {
      return "/";
    }
    return path.slice(0, lastSep);
  }
}

export function isAncestorOf(
  ancestorPath: string,
  descendantPath: string
): boolean {
  if (ancestorPath === descendantPath) {
    return true;
  }

  const ancestorWithSep = ancestorPath.endsWith(sep)
    ? ancestorPath
    : ancestorPath + sep;

  if (isWindows()) {
    return descendantPath.toLowerCase().startsWith(ancestorWithSep.toLowerCase());
  }

  return descendantPath.startsWith(ancestorWithSep);
}
