import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalize,
  getAncestors,
  isAncestorOf,
  normalizePath,
} from "../src/core/path.ts";

describe("canonicalize", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `burrow-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("resolves absolute path", async () => {
    const result = await canonicalize(testDir);
    expect(result).toBe(testDir);
  });

  test("resolves relative path to absolute", async () => {
    const result = await canonicalize(".");
    expect(result).toMatch(/^\//);
    expect(result).not.toContain(".");
  });

  test("handles non-existent paths when followSymlinks is false", async () => {
    const nonExistent = join(testDir, "does-not-exist");
    const result = await canonicalize(nonExistent, { followSymlinks: false });
    expect(result).toBe(nonExistent);
  });

  test("handles non-existent paths when followSymlinks is true", async () => {
    const nonExistent = join(testDir, "does-not-exist");
    const result = await canonicalize(nonExistent, { followSymlinks: true });
    expect(result).toBe(nonExistent);
  });
});

describe("getAncestors", () => {
  test("returns all ancestors for a deep path", () => {
    const ancestors = getAncestors("/home/user/projects/myapp");
    expect(ancestors).toEqual([
      "/",
      "/home",
      "/home/user",
      "/home/user/projects",
      "/home/user/projects/myapp",
    ]);
  });

  test("returns single ancestor for root", () => {
    const ancestors = getAncestors("/");
    expect(ancestors).toEqual(["/"]);
  });

  test("returns ancestors in shallow to deep order", () => {
    const ancestors = getAncestors("/a/b/c");
    expect(ancestors[0]).toBe("/");
    expect(ancestors[ancestors.length - 1]).toBe("/a/b/c");
  });
});

describe("isAncestorOf", () => {
  test("returns true for direct parent", () => {
    expect(isAncestorOf("/home/user", "/home/user/projects")).toBe(true);
  });

  test("returns true for same path", () => {
    expect(isAncestorOf("/home/user", "/home/user")).toBe(true);
  });

  test("returns true for deep descendant", () => {
    expect(isAncestorOf("/home", "/home/user/projects/myapp/src")).toBe(true);
  });

  test("returns true for root ancestor", () => {
    expect(isAncestorOf("/", "/home/user")).toBe(true);
  });

  test("returns false for sibling paths", () => {
    expect(isAncestorOf("/home/user1", "/home/user2")).toBe(false);
  });

  test("returns false for partial path matches", () => {
    expect(isAncestorOf("/home/user", "/home/username")).toBe(false);
  });

  test("returns false when paths have no relationship", () => {
    expect(isAncestorOf("/var/log", "/home/user")).toBe(false);
  });
});

describe("normalizePath", () => {
  test("handles paths with double slashes", () => {
    const result = normalizePath("/home//user");
    expect(result).toBe("/home/user");
  });

  test("keeps trailing slashes", () => {
    const result = normalizePath("/home/user/");
    expect(result).toBe("/home/user/");
  });

  test("resolves . and .. components", () => {
    const result = normalizePath("/home/user/./projects/../documents");
    expect(result).toBe("/home/user/documents");
  });
});
