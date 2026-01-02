import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BurrowClient } from "../src/api.ts";

describe("Trust functionality", () => {
  let testDir: string;
  let configDir: string;
  let client: BurrowClient;

  beforeEach(async () => {
    testDir = join(tmpdir(), `burrow-trust-test-${Date.now()}`);
    configDir = join(testDir, "config");
    await mkdir(configDir, { recursive: true });
    await mkdir(join(testDir, "projects", "myapp", "src"), { recursive: true });
    await mkdir(join(testDir, "other"), { recursive: true });

    client = new BurrowClient({ configDir });
  });

  afterEach(async () => {
    client.close();
    await rm(testDir, { recursive: true, force: true });
  });

  describe("trust", () => {
    test("trusts a directory and returns path and inode", async () => {
      const result = await client.trust({ path: testDir });
      
      expect(result.path).toBe(testDir);
      expect(result.inode).toBeDefined();
      expect(result.inode).not.toBe("");
    });

    test("trusting same directory twice updates the entry", async () => {
      await client.trust({ path: testDir });
      const result2 = await client.trust({ path: testDir });
      
      expect(result2.path).toBe(testDir);
      
      const trusted = await client.listTrusted();
      expect(trusted.length).toBe(1);
    });
  });

  describe("untrust", () => {
    test("untrusts a previously trusted directory", async () => {
      await client.trust({ path: testDir });
      const removed = await client.untrust({ path: testDir });
      
      expect(removed).toBe(true);
      
      const trusted = await client.listTrusted();
      expect(trusted.length).toBe(0);
    });

    test("returns false for non-trusted directory", async () => {
      const removed = await client.untrust({ path: testDir });
      expect(removed).toBe(false);
    });
  });

  describe("isTrusted", () => {
    test("returns trusted for directly trusted path", async () => {
      await client.trust({ path: testDir });
      
      const result = await client.isTrusted({ path: testDir });
      
      expect(result.trusted).toBe(true);
      expect(result.trustedPath).toBe(testDir);
    });

    test("returns trusted for child of trusted path (inheritance)", async () => {
      const projectPath = join(testDir, "projects");
      await client.trust({ path: projectPath });
      
      const result = await client.isTrusted({ path: join(projectPath, "myapp", "src") });
      
      expect(result.trusted).toBe(true);
      expect(result.trustedPath).toBe(projectPath);
    });

    test("returns not-trusted for untrusted path", async () => {
      const result = await client.isTrusted({ path: testDir });
      
      expect(result.trusted).toBe(false);
      expect(result.reason).toBe("not-trusted");
    });

    test("returns not-trusted for sibling of trusted path", async () => {
      const projectPath = join(testDir, "projects");
      await client.trust({ path: projectPath });
      
      const result = await client.isTrusted({ path: join(testDir, "other") });
      
      expect(result.trusted).toBe(false);
      expect(result.reason).toBe("not-trusted");
    });
  });

  describe("listTrusted", () => {
    test("returns empty array when no paths trusted", async () => {
      const trusted = await client.listTrusted();
      expect(trusted).toEqual([]);
    });

    test("returns all trusted paths", async () => {
      await client.trust({ path: testDir });
      await client.trust({ path: join(testDir, "projects") });
      
      const trusted = await client.listTrusted();
      
      expect(trusted.length).toBe(2);
      expect(trusted.map(t => t.path).sort()).toEqual([
        testDir,
        join(testDir, "projects"),
      ].sort());
    });

    test("includes trustedAt timestamp", async () => {
      const before = new Date().toISOString();
      await client.trust({ path: testDir });
      const after = new Date().toISOString();
      
      const trusted = await client.listTrusted();
      
      expect(trusted.length).toBe(1);
      expect(trusted[0]!.trustedAt >= before).toBe(true);
      expect(trusted[0]!.trustedAt <= after).toBe(true);
    });
  });
});
