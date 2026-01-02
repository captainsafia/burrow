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
      expect(result.secrets.length).toBe(1);
      expect(result.secrets[0]!.key).toBe("API_KEY");
      expect(result.secrets[0]!.value).toBe("secret123");
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

    test("loads inherited secrets in subdirectory", async () => {
      const projectPath = join(testDir, "projects");
      
      await client.trust({ path: testDir });
      await client.set("GLOBAL_KEY", "global", { path: testDir });
      await client.set("PROJECT_KEY", "project", { path: projectPath });
      
      // Hook in subdirectory should get both secrets
      const result = await client.hook(projectPath, { shell: "bash" });
      
      expect(result.trusted).toBe(true);
      expect(result.secrets.length).toBe(2);
      
      const keys = result.secrets.map(s => s.key).sort();
      expect(keys).toEqual(["GLOBAL_KEY", "PROJECT_KEY"]);
    });

    test("returns empty secrets for trusted directory with no secrets", async () => {
      await client.trust({ path: testDir });
      
      const result = await client.hook(testDir, { shell: "bash" });
      
      expect(result.trusted).toBe(true);
      expect(result.secrets).toEqual([]);
      expect(result.commands).toEqual([]);
    });

    test("returns message with loaded count", async () => {
      await client.trust({ path: testDir });
      await client.set("KEY1", "value1", { path: testDir });
      await client.set("KEY2", "value2", { path: testDir });
      
      const result = await client.hook(testDir, { shell: "bash", useColor: false });
      
      expect(result.message).toBeDefined();
      expect(result.message).toContain("loaded 2 secrets");
    });

    test("returns no message when no secrets", async () => {
      await client.trust({ path: testDir });
      
      const result = await client.hook(testDir, { shell: "bash" });
      
      expect(result.message).toBeUndefined();
    });

    test("escapes special characters in bash", async () => {
      await client.trust({ path: testDir });
      await client.set("SPECIAL", "hello 'world' $var", { path: testDir });
      
      const result = await client.hook(testDir, { shell: "bash" });
      
      expect(result.commands[0]).toContain("$'");
      expect(result.commands[0]).toContain("\\'");
    });

    test("escapes special characters in fish", async () => {
      await client.trust({ path: testDir });
      await client.set("SPECIAL", "hello 'world'", { path: testDir });
      
      const result = await client.hook(testDir, { shell: "fish" });
      
      // Fish escapes single quotes differently
      expect(result.commands[0]).toMatch(/set -gx SPECIAL/);
    });

    test("unloads secrets when leaving trusted directory", async () => {
      await client.trust({ path: testDir });
      await client.set("API_KEY", "secret123", { path: testDir });
      
      // First hook loads the secret
      const result1 = await client.hook(testDir, { shell: "bash" });
      expect(result1.secrets.length).toBe(1);
      
      // Simulate leaving to untrusted directory with previous keys
      const result2 = await client.hook("/tmp", { 
        shell: "bash",
        previousKeys: ["API_KEY"]
      });
      
      expect(result2.trusted).toBe(false);
      expect(result2.unloadedKeys).toContain("API_KEY");
      expect(result2.commands).toContain("unset API_KEY");
    });

    test("unloads secrets when navigating to directory with different secrets", async () => {
      const projectPath = join(testDir, "projects");
      const otherPath = join(testDir, "other");
      
      await client.trust({ path: testDir });
      await client.set("PROJECT_KEY", "project", { path: projectPath });
      await client.set("OTHER_KEY", "other", { path: otherPath });
      
      // First hook in projects
      const result1 = await client.hook(projectPath, { shell: "bash" });
      expect(result1.secrets.map(s => s.key)).toContain("PROJECT_KEY");
      
      // Move to other directory with previous keys
      const result2 = await client.hook(otherPath, { 
        shell: "bash",
        previousKeys: ["PROJECT_KEY"]
      });
      
      expect(result2.unloadedKeys).toContain("PROJECT_KEY");
      expect(result2.secrets.map(s => s.key)).toContain("OTHER_KEY");
      expect(result2.commands).toContain("unset PROJECT_KEY");
    });

    test("generates fish unset commands", async () => {
      await client.trust({ path: testDir });
      await client.set("API_KEY", "secret", { path: testDir });
      
      // Simulate leaving trusted area
      const result = await client.hook("/tmp", { 
        shell: "fish",
        previousKeys: ["API_KEY"]
      });
      
      expect(result.commands).toContain("set -e API_KEY");
    });

    test("returns unloaded message when leaving", async () => {
      await client.trust({ path: testDir });
      
      const result = await client.hook("/tmp", { 
        shell: "bash",
        previousKeys: ["KEY1", "KEY2"],
        useColor: false
      });
      
      expect(result.message).toBeDefined();
      expect(result.message).toContain("unloaded 2");
    });
  });
});
