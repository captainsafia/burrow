import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Resolver } from "../src/core/resolver.ts";
import { Storage } from "../src/storage/index.ts";

describe("Resolver", () => {
  let testDir: string;
  let configDir: string;
  let storage: Storage;
  let resolver: Resolver;

  beforeEach(async () => {
    testDir = join(tmpdir(), `burrow-test-${Date.now()}`);
    configDir = join(testDir, "config");
    await mkdir(configDir, { recursive: true });
    await mkdir(join(testDir, "projects", "myapp", "src"), { recursive: true });

    storage = new Storage({ configDir });
    resolver = new Resolver({ configDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("resolve", () => {
    test("returns empty map when no secrets exist", async () => {
      const secrets = await resolver.resolve(testDir);
      expect(secrets.size).toBe(0);
    });

    test("resolves secret at exact path", async () => {
      await storage.setSecret(testDir, "MY_KEY", "my_value");

      const secrets = await resolver.resolve(testDir);
      expect(secrets.get("MY_KEY")?.value).toBe("my_value");
      expect(secrets.get("MY_KEY")?.sourcePath).toBe(testDir);
    });

    test("inherits secrets from ancestor paths", async () => {
      await storage.setSecret(testDir, "ROOT_KEY", "root_value");
      const childPath = join(testDir, "projects");

      const secrets = await resolver.resolve(childPath);
      expect(secrets.get("ROOT_KEY")?.value).toBe("root_value");
      expect(secrets.get("ROOT_KEY")?.sourcePath).toBe(testDir);
    });

    test("deeper scope overrides shallower scope", async () => {
      await storage.setSecret(testDir, "KEY", "parent_value");
      const childPath = join(testDir, "projects");
      await storage.setSecret(childPath, "KEY", "child_value");

      const secrets = await resolver.resolve(childPath);
      expect(secrets.get("KEY")?.value).toBe("child_value");
      expect(secrets.get("KEY")?.sourcePath).toBe(childPath);
    });

    test("merges keys from multiple ancestor scopes", async () => {
      await storage.setSecret(testDir, "ROOT_KEY", "root");
      const projects = join(testDir, "projects");
      await storage.setSecret(projects, "PROJECT_KEY", "project");
      const myapp = join(projects, "myapp");
      await storage.setSecret(myapp, "APP_KEY", "app");

      const secrets = await resolver.resolve(myapp);
      expect(secrets.get("ROOT_KEY")?.value).toBe("root");
      expect(secrets.get("PROJECT_KEY")?.value).toBe("project");
      expect(secrets.get("APP_KEY")?.value).toBe("app");
    });

    test("tombstone removes inherited key", async () => {
      await storage.setSecret(testDir, "KEY", "value");
      const childPath = join(testDir, "projects");
      await storage.setSecret(childPath, "KEY", null);

      const secrets = await resolver.resolve(childPath);
      expect(secrets.has("KEY")).toBe(false);
    });

    test("tombstone only affects that key", async () => {
      await storage.setSecret(testDir, "KEY1", "value1");
      await storage.setSecret(testDir, "KEY2", "value2");
      const childPath = join(testDir, "projects");
      await storage.setSecret(childPath, "KEY1", null);

      const secrets = await resolver.resolve(childPath);
      expect(secrets.has("KEY1")).toBe(false);
      expect(secrets.get("KEY2")?.value).toBe("value2");
    });

    test("tombstone can be overridden by deeper scope", async () => {
      await storage.setSecret(testDir, "KEY", "root");
      const projects = join(testDir, "projects");
      await storage.setSecret(projects, "KEY", null);
      const myapp = join(projects, "myapp");
      await storage.setSecret(myapp, "KEY", "reactivated");

      const secrets = await resolver.resolve(myapp);
      expect(secrets.get("KEY")?.value).toBe("reactivated");
    });

    test("does not include secrets from unrelated paths", async () => {
      const unrelatedPath = join(tmpdir(), "unrelated-path");
      await storage.setSecret(unrelatedPath, "UNRELATED_KEY", "value");

      const secrets = await resolver.resolve(testDir);
      expect(secrets.has("UNRELATED_KEY")).toBe(false);
    });
  });

  describe("get", () => {
    test("returns undefined for non-existent key", async () => {
      const secret = await resolver.get("NONEXISTENT", testDir);
      expect(secret).toBeUndefined();
    });

    test("returns resolved secret with sourcePath", async () => {
      await storage.setSecret(testDir, "KEY", "value");
      const childPath = join(testDir, "projects");

      const secret = await resolver.get("KEY", childPath);
      expect(secret?.value).toBe("value");
      expect(secret?.sourcePath).toBe(testDir);
    });
  });

  describe("list", () => {
    test("returns empty array when no secrets exist", async () => {
      const secrets = await resolver.list(testDir);
      expect(secrets).toEqual([]);
    });

    test("returns sorted list of resolved secrets", async () => {
      await storage.setSecret(testDir, "ZEBRA", "z");
      await storage.setSecret(testDir, "ALPHA", "a");
      await storage.setSecret(testDir, "MIDDLE", "m");

      const secrets = await resolver.list(testDir);
      expect(secrets.map((s) => s.key)).toEqual(["ALPHA", "MIDDLE", "ZEBRA"]);
    });
  });
});
