import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BurrowClient } from "../src/api.ts";

describe("Hook functionality", () => {
  let testDir: string;
  let configDir: string;
  let client: BurrowClient;

  beforeEach(async () => {
    testDir = join(tmpdir(), `burrow-hook-test-${Date.now()}`);
    configDir = join(testDir, "config");
    await mkdir(configDir, { recursive: true });
    await mkdir(join(testDir, "projects", "myapp"), { recursive: true });
    await mkdir(join(testDir, "other"), { recursive: true });

    client = new BurrowClient({ configDir });
  });

  afterEach(async () => {
    client.close();
    await rm(testDir, { recursive: true, force: true });
  });

  describe("getHookState", () => {
    test("returns undefined when no state exists", async () => {
      const state = await client.getHookState();
      expect(state).toBeUndefined();
    });
  });

  describe("clearHookState", () => {
    test("clears hook state without error", async () => {
      await client.clearHookState();
      const state = await client.getHookState();
      expect(state).toBeUndefined();
    });
  });

  describe("hook", () => {
    test("returns not trusted for untrusted directory", async () => {
      const result = await client.hook(testDir, { shell: "bash" });
      
      expect(result.trusted).toBe(false);
      expect(result.notTrustedReason).toBe("not-trusted");
      expect(result.commands).toEqual([]);
    });

    test("returns autoload-disabled when BURROW_AUTOLOAD=0", async () => {
      const oldValue = process.env["BURROW_AUTOLOAD"];
      try {
        process.env["BURROW_AUTOLOAD"] = "0";
        
        await client.trust({ path: testDir });
        const result = await client.hook(testDir, { shell: "bash" });
        
        expect(result.trusted).toBe(false);
        expect(result.notTrustedReason).toBe("autoload-disabled");
      } finally {
        if (oldValue === undefined) {
          delete process.env["BURROW_AUTOLOAD"];
        } else {
          process.env["BURROW_AUTOLOAD"] = oldValue;
        }
      }
    });

    test("loads secrets from trusted directory", async () => {
      await client.trust({ path: testDir });
      await client.set("API_KEY", "secret123", { path: testDir });
      
      const result = await client.hook(testDir, { shell: "bash" });
      
      expect(result.trusted).toBe(true);
      expect(result.diff.set.length).toBe(1);
      expect(result.diff.set[0]!.key).toBe("API_KEY");
      expect(result.diff.set[0]!.value).toBe("secret123");
    });

    test("generates bash export commands", async () => {
      await client.trust({ path: testDir });
      await client.set("API_KEY", "secret123", { path: testDir });
      
      const result = await client.hook(testDir, { shell: "bash" });
      
      expect(result.commands.length).toBe(1);
      expect(result.commands[0]).toMatch(/^export API_KEY=/);
    });

    test("generates fish set commands", async () => {
      await client.trust({ path: testDir });
      await client.set("API_KEY", "secret123", { path: testDir });
      
      const result = await client.hook(testDir, { shell: "fish" });
      
      expect(result.commands.length).toBe(1);
      expect(result.commands[0]).toMatch(/^set -gx API_KEY/);
    });

    test("computes diff correctly for directory change", async () => {
      const projectPath = join(testDir, "projects");
      
      await client.trust({ path: testDir });
      await client.set("GLOBAL_KEY", "global", { path: testDir });
      await client.set("PROJECT_KEY", "project", { path: projectPath });
      
      // First hook - load global secrets
      const result1 = await client.hook(testDir, { shell: "bash" });
      expect(result1.diff.set.length).toBe(1);
      expect(result1.diff.set[0]!.key).toBe("GLOBAL_KEY");
      
      // Second hook - move to projects, should add PROJECT_KEY
      const result2 = await client.hook(projectPath, { shell: "bash" });
      expect(result2.diff.set.length).toBe(1);
      expect(result2.diff.set[0]!.key).toBe("PROJECT_KEY");
      expect(result2.diff.unchanged).toContain("GLOBAL_KEY");
    });

    test("unsets secrets when leaving scope", async () => {
      const projectPath = join(testDir, "projects");
      const otherPath = join(testDir, "other");
      
      await client.trust({ path: testDir });
      await client.set("PROJECT_KEY", "project", { path: projectPath });
      
      // Enter projects
      await client.hook(projectPath, { shell: "bash" });
      
      // Leave to other directory - should unset PROJECT_KEY
      const result = await client.hook(otherPath, { shell: "bash" });
      expect(result.diff.unset).toContain("PROJECT_KEY");
    });

    test("generates bash unset commands", async () => {
      const projectPath = join(testDir, "projects");
      const otherPath = join(testDir, "other");
      
      await client.trust({ path: testDir });
      await client.set("PROJECT_KEY", "project", { path: projectPath });
      
      await client.hook(projectPath, { shell: "bash" });
      const result = await client.hook(otherPath, { shell: "bash" });
      
      expect(result.commands).toContain("unset PROJECT_KEY");
    });

    test("generates fish unset commands", async () => {
      const projectPath = join(testDir, "projects");
      const otherPath = join(testDir, "other");
      
      await client.trust({ path: testDir });
      await client.set("PROJECT_KEY", "project", { path: projectPath });
      
      await client.hook(projectPath, { shell: "fish" });
      const result = await client.hook(otherPath, { shell: "fish" });
      
      expect(result.commands).toContain("set -e PROJECT_KEY");
    });

    test("updates hook state after hook call", async () => {
      await client.trust({ path: testDir });
      await client.set("API_KEY", "secret123", { path: testDir });
      
      await client.hook(testDir, { shell: "bash" });
      
      const state = await client.getHookState();
      expect(state).toBeDefined();
      expect(state!.secrets.length).toBe(1);
      expect(state!.secrets[0]!.key).toBe("API_KEY");
      expect(state!.lastDir).toBe(testDir);
    });

    test("returns message with loaded count", async () => {
      await client.trust({ path: testDir });
      await client.set("KEY1", "value1", { path: testDir });
      await client.set("KEY2", "value2", { path: testDir });
      
      const result = await client.hook(testDir, { shell: "bash", useColor: false });
      
      expect(result.message).toBeDefined();
      expect(result.message).toContain("loaded 2 secrets");
    });

    test("returns no message when nothing changes", async () => {
      await client.trust({ path: testDir });
      
      const result = await client.hook(testDir, { shell: "bash" });
      
      expect(result.message).toBeUndefined();
    });
  });
});
