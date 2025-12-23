import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BurrowClient } from "../src/api.ts";

describe("BurrowClient", () => {
  let testDir: string;
  let configDir: string;
  let client: BurrowClient;

  beforeEach(async () => {
    testDir = join(tmpdir(), `burrow-test-${Date.now()}`);
    configDir = join(testDir, "config");
    await mkdir(configDir, { recursive: true });
    await mkdir(join(testDir, "projects", "myapp"), { recursive: true });

    client = new BurrowClient({ configDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("set", () => {
    test("sets a secret at the default path", async () => {
      await client.set("MY_KEY", "my_value", { path: testDir });

      const secret = await client.get("MY_KEY", { cwd: testDir });
      expect(secret?.value).toBe("my_value");
    });

    test("sets a secret at a specific path", async () => {
      const projectPath = join(testDir, "projects");
      await client.set("PROJECT_KEY", "project_value", { path: projectPath });

      const secret = await client.get("PROJECT_KEY", { cwd: projectPath });
      expect(secret?.value).toBe("project_value");
    });

    test("throws for invalid key format", async () => {
      await expect(
        client.set("invalid-key", "value", { path: testDir })
      ).rejects.toThrow("Invalid environment variable key");
    });

    test("overwrites existing value", async () => {
      await client.set("KEY", "value1", { path: testDir });
      await client.set("KEY", "value2", { path: testDir });

      const secret = await client.get("KEY", { cwd: testDir });
      expect(secret?.value).toBe("value2");
    });
  });

  describe("get", () => {
    test("returns undefined for non-existent key", async () => {
      const secret = await client.get("NONEXISTENT", { cwd: testDir });
      expect(secret).toBeUndefined();
    });

    test("returns secret with sourcePath", async () => {
      await client.set("KEY", "value", { path: testDir });

      const secret = await client.get("KEY", { cwd: testDir });
      expect(secret?.key).toBe("KEY");
      expect(secret?.value).toBe("value");
      expect(secret?.sourcePath).toBe(testDir);
    });

    test("inherits from parent path", async () => {
      await client.set("PARENT_KEY", "parent", { path: testDir });
      const childPath = join(testDir, "projects");

      const secret = await client.get("PARENT_KEY", { cwd: childPath });
      expect(secret?.value).toBe("parent");
      expect(secret?.sourcePath).toBe(testDir);
    });
  });

  describe("list", () => {
    test("returns empty array when no secrets exist", async () => {
      const secrets = await client.list({ cwd: testDir });
      expect(secrets).toEqual([]);
    });

    test("returns all resolved secrets sorted by key", async () => {
      await client.set("ZEBRA", "z", { path: testDir });
      await client.set("ALPHA", "a", { path: testDir });

      const secrets = await client.list({ cwd: testDir });
      expect(secrets.length).toBe(2);
      expect(secrets[0]?.key).toBe("ALPHA");
      expect(secrets[1]?.key).toBe("ZEBRA");
    });

    test("includes inherited secrets", async () => {
      await client.set("PARENT", "parent", { path: testDir });
      const childPath = join(testDir, "projects");
      await client.set("CHILD", "child", { path: childPath });

      const secrets = await client.list({ cwd: childPath });
      expect(secrets.length).toBe(2);
      expect(secrets.find((s) => s.key === "PARENT")).toBeDefined();
      expect(secrets.find((s) => s.key === "CHILD")).toBeDefined();
    });
  });

  describe("block", () => {
    test("creates tombstone that blocks inheritance", async () => {
      await client.set("KEY", "value", { path: testDir });
      const childPath = join(testDir, "projects");
      await client.block("KEY", { path: childPath });

      const secret = await client.get("KEY", { cwd: childPath });
      expect(secret).toBeUndefined();
    });

    test("does not affect parent scope", async () => {
      await client.set("KEY", "value", { path: testDir });
      const childPath = join(testDir, "projects");
      await client.block("KEY", { path: childPath });

      const secret = await client.get("KEY", { cwd: testDir });
      expect(secret?.value).toBe("value");
    });

    test("throws for invalid key format", async () => {
      await expect(
        client.block("invalid-key", { path: testDir })
      ).rejects.toThrow("Invalid environment variable key");
    });
  });

  describe("export", () => {
    test("exports empty string when no secrets", async () => {
      const output = await client.export({ cwd: testDir, format: "shell" });
      expect(output).toBe("");
    });

    test("exports in shell format by default", async () => {
      await client.set("KEY", "value", { path: testDir });

      const output = await client.export({ cwd: testDir });
      expect(output).toBe("export KEY='value'");
    });

    test("exports in dotenv format", async () => {
      await client.set("KEY", "value", { path: testDir });

      const output = await client.export({ cwd: testDir, format: "dotenv" });
      expect(output).toBe('KEY="value"');
    });

    test("exports in json format", async () => {
      await client.set("KEY", "value", { path: testDir });

      const output = await client.export({ cwd: testDir, format: "json" });
      expect(JSON.parse(output)).toEqual({ KEY: "value" });
    });

    test("includes sources in json when requested", async () => {
      await client.set("KEY", "value", { path: testDir });

      const output = await client.export({
        cwd: testDir,
        format: "json",
        includeSources: true,
      });
      const parsed = JSON.parse(output);
      expect(parsed.KEY.value).toBe("value");
      expect(parsed.KEY.sourcePath).toBe(testDir);
    });
  });

  describe("resolve", () => {
    test("returns Map of resolved secrets", async () => {
      await client.set("KEY1", "value1", { path: testDir });
      await client.set("KEY2", "value2", { path: testDir });

      const resolved = await client.resolve(testDir);
      expect(resolved).toBeInstanceOf(Map);
      expect(resolved.size).toBe(2);
      expect(resolved.get("KEY1")?.value).toBe("value1");
      expect(resolved.get("KEY2")?.value).toBe("value2");
    });
  });
});
