import { stat } from "node:fs/promises";
import { type Storage, type TrustedPath } from "../storage/index.ts";
import { canonicalize, type PathOptions } from "./path.ts";

export interface TrustResult {
  path: string;
  inode: string;
}

export interface TrustCheckResult {
  trusted: boolean;
  trustedPath?: string;
  reason?: "not-trusted" | "inode-mismatch" | "path-not-found";
}

export interface TrustOptions extends PathOptions {
  storage: Storage;
}

/**
 * Gets the inode (Unix) or file ID (Windows) for a path.
 */
export async function getInode(path: string): Promise<string> {
  const stats = await stat(path);
  // On Unix, use inode number
  // On Windows, Bun provides ino which is the file index
  return stats.ino.toString();
}

export class TrustManager {
  private readonly storage: Storage;
  private readonly pathOptions: PathOptions;

  constructor(options: TrustOptions) {
    this.storage = options.storage;
    this.pathOptions = {
      followSymlinks: options.followSymlinks,
    };
  }

  /**
   * Trusts a directory for auto-loading.
   * 
   * @param targetPath - The path to trust
   * @returns The trusted path info with canonicalized path and inode
   */
  async trust(targetPath: string): Promise<TrustResult> {
    const canonicalPath = await canonicalize(targetPath, this.pathOptions);
    const inode = await getInode(canonicalPath);
    
    await this.storage.addTrustedPath(canonicalPath, inode);
    
    return { path: canonicalPath, inode };
  }

  /**
   * Removes trust from a directory.
   * 
   * @param targetPath - The path to untrust
   * @returns true if the path was trusted and is now untrusted, false if it wasn't trusted
   */
  async untrust(targetPath: string): Promise<boolean> {
    const canonicalPath = await canonicalize(targetPath, this.pathOptions);
    return this.storage.removeTrustedPath(canonicalPath);
  }

  /**
   * Checks if a directory is trusted (directly or via ancestor).
   * Also validates that the inode matches to detect directory replacements.
   * 
   * @param targetPath - The path to check
   * @returns Trust check result with trusted status and any reason for failure
   */
  async isTrusted(targetPath: string): Promise<TrustCheckResult> {
    let canonicalPath: string;
    try {
      canonicalPath = await canonicalize(targetPath, this.pathOptions);
    } catch {
      return { trusted: false, reason: "path-not-found" };
    }

    // Get all trusted ancestor paths
    const trustedAncestors = await this.storage.getTrustedAncestorPaths(canonicalPath);
    
    if (trustedAncestors.length === 0) {
      return { trusted: false, reason: "not-trusted" };
    }

    // Check each trusted ancestor - find the deepest one that's still valid
    // Sort by path length descending to check deepest first
    trustedAncestors.sort((a, b) => b.path.length - a.path.length);

    for (const trusted of trustedAncestors) {
      try {
        const currentInode = await getInode(trusted.path);
        if (currentInode === trusted.inode) {
          return { trusted: true, trustedPath: trusted.path };
        }
        // Inode mismatch - this trusted path is stale, continue checking others
      } catch {
        // Path no longer exists, continue checking others
      }
    }

    // All trusted ancestors had inode mismatches or were missing
    return { trusted: false, reason: "inode-mismatch" };
  }

  /**
   * Gets all trusted paths.
   * 
   * @returns Array of all trusted path entries
   */
  async list(): Promise<TrustedPath[]> {
    return this.storage.getAllTrustedPaths();
  }
}
