import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../src/storage/index.ts";

describe("Storage", () => {
  let testDir: string;
  let storage: Storage;

  beforeEach(async () => {
    testDir = join(tmpdir(), `burrow-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    storage = new Storage({ configDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    test("creates database when first operation is performed", async () => {
      await storage.setSecret("/test", "KEY", "value");
      expect(existsSync(join(testDir, "store.db"))).toBe(true);
    });

    test("creates config directory if it does not exist", async () => {
      const nestedDir = join(testDir, "nested", "config");
      const nestedStorage = new Storage({ configDir: nestedDir });

      await nestedStorage.setSecret("/test", "KEY", "value");

      expect(existsSync(join(nestedDir, "store.db"))).toBe(true);
    });

    test("reads existing database", async () => {
      const db = new Database(join(testDir, "store.db"));
      db.run("PRAGMA user_version = 1");
      db.run(`
        CREATE TABLE secrets (path TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (path, key))
      `);
      db.run("INSERT INTO secrets (path, key, value, updated_at) VALUES ('/test/path', 'MY_KEY', 'my_value', '2025-01-01T00:00:00.000Z')");
      db.close();

      const secrets = await storage.getPathSecrets("/test/path");
      expect(secrets?.["MY_KEY"]?.value).toBe("my_value");
      expect(secrets?.["MY_KEY"]?.updatedAt).toBe("2025-01-01T00:00:00.000Z");
    });

    test("throws on unsupported version", async () => {
      const db = new Database(join(testDir, "store.db"));
      db.run("PRAGMA user_version = 999");
      db.run(`
        CREATE TABLE secrets (path TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (path, key))
      `);
      db.close();

      await expect(storage.getAllPaths()).rejects.toThrow("Unsupported store version");
    });
  });

  describe("setSecret", () => {
    test("creates new path entry if missing", async () => {
      await storage.setSecret("/new/path", "MY_KEY", "my_value");

      const secrets = await storage.getPathSecrets("/new/path");
      expect(secrets?.["MY_KEY"]?.value).toBe("my_value");
    });

    test("overwrites existing value at same path", async () => {
      await storage.setSecret("/test", "KEY", "value1");
      await storage.setSecret("/test", "KEY", "value2");

      const secrets = await storage.getPathSecrets("/test");
      expect(secrets?.["KEY"]?.value).toBe("value2");
    });

    test("stores tombstone when value is null", async () => {
      await storage.setSecret("/test", "KEY", null);

      const secrets = await storage.getPathSecrets("/test");
      expect(secrets?.["KEY"]?.value).toBeNull();
    });

    test("sets updatedAt timestamp", async () => {
      const before = new Date().toISOString();
      await storage.setSecret("/test", "KEY", "value");
      const after = new Date().toISOString();

      const secrets = await storage.getPathSecrets("/test");
      const updatedAt = secrets?.["KEY"]?.updatedAt;
      expect(updatedAt).toBeDefined();
      expect(updatedAt! >= before).toBe(true);
      expect(updatedAt! <= after).toBe(true);
    });
  });

  describe("getPathSecrets", () => {
    test("returns undefined for non-existent path", async () => {
      const secrets = await storage.getPathSecrets("/nonexistent");
      expect(secrets).toBeUndefined();
    });

    test("returns secrets for existing path", async () => {
      await storage.setSecret("/test", "KEY1", "value1");
      await storage.setSecret("/test", "KEY2", "value2");

      const secrets = await storage.getPathSecrets("/test");
      expect(secrets?.["KEY1"]?.value).toBe("value1");
      expect(secrets?.["KEY2"]?.value).toBe("value2");
    });
  });

  describe("getAllPaths", () => {
    test("returns empty array when no paths exist", async () => {
      const paths = await storage.getAllPaths();
      expect(paths).toEqual([]);
    });

    test("returns all stored paths", async () => {
      await storage.setSecret("/path1", "KEY", "value");
      await storage.setSecret("/path2", "KEY", "value");
      await storage.setSecret("/path3", "KEY", "value");

      const paths = await storage.getAllPaths();
      expect(paths.sort()).toEqual(["/path1", "/path2", "/path3"]);
    });
  });

  describe("removeKey", () => {
    test("returns false when path does not exist", async () => {
      const result = await storage.removeKey("/nonexistent", "KEY");
      expect(result).toBe(false);
    });

    test("returns false when key does not exist", async () => {
      await storage.setSecret("/test", "OTHER_KEY", "value");
      const result = await storage.removeKey("/test", "NONEXISTENT");
      expect(result).toBe(false);
    });

    test("removes key and returns true", async () => {
      await storage.setSecret("/test", "KEY", "value");
      const result = await storage.removeKey("/test", "KEY");

      expect(result).toBe(true);
      const secrets = await storage.getPathSecrets("/test");
      expect(secrets).toBeUndefined();
    });

    test("removes path entry when last key is removed", async () => {
      await storage.setSecret("/test", "KEY", "value");
      await storage.removeKey("/test", "KEY");

      const paths = await storage.getAllPaths();
      expect(paths).not.toContain("/test");
    });
  });
});
