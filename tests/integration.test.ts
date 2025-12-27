import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface TestContext {
  configDir: string;
  workspaceDir: string;
  root: string;
  repo: string;
  sub: string;
}

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

async function runBurrow(
  args: string[],
  options: { cwd: string; configDir: string }
): Promise<RunResult> {
  const result = await $`bun ${CLI_PATH} ${args}`
    .cwd(options.cwd)
    .env({ ...process.env, BURROW_CONFIG_DIR: options.configDir })
    .nothrow()
    .quiet();

  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

async function createTestContext(): Promise<TestContext> {
  const base = join(tmpdir(), `burrow-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const configDir = join(base, "config");
  const workspaceDir = join(base, "workspace");
  const root = join(workspaceDir, "root");
  const repo = join(root, "repo");
  const sub = join(repo, "sub");

  await mkdir(configDir, { recursive: true });
  await mkdir(sub, { recursive: true });

  return { configDir, workspaceDir, root, repo, sub };
}

async function cleanupTestContext(ctx: TestContext): Promise<void> {
  const base = join(ctx.configDir, "..");
  await rm(base, { recursive: true, force: true });
}

describe("Integration Tests", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await cleanupTestContext(ctx);
  });

  describe("Core happy paths", () => {
    test("1. Set then get in same directory", async () => {
      const set = await runBurrow(["set", "API_KEY=123"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(set.exitCode).toBe(0);

      const get = await runBurrow(["get", "API_KEY", "--format", "json"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(get.exitCode).toBe(0);
      const parsed = JSON.parse(get.stdout);
      expect(parsed.key).toBe("API_KEY");
      expect(parsed.sourcePath).toBe(ctx.repo);
    });

    test("2. Set in parent, get in child (inheritance)", async () => {
      await runBurrow(["set", "PARENT_KEY=inherited"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const get = await runBurrow(["get", "PARENT_KEY", "--format", "json"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });
      expect(get.exitCode).toBe(0);
      const parsed = JSON.parse(get.stdout);
      expect(parsed.sourcePath).toBe(ctx.repo);
    });

    test("3. Override in child (nearest wins)", async () => {
      await runBurrow(["set", "API_KEY=parent"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      await runBurrow(["set", "API_KEY=child"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });

      const getChild = await runBurrow(["get", "API_KEY", "--format", "json"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });
      const childParsed = JSON.parse(getChild.stdout);
      expect(childParsed.sourcePath).toBe(ctx.sub);

      const getParent = await runBurrow(["get", "API_KEY", "--format", "json"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      const parentParsed = JSON.parse(getParent.stdout);
      expect(parentParsed.sourcePath).toBe(ctx.repo);
    });

    test("4. Multiple keys + merge across scopes", async () => {
      await runBurrow(["set", "A=1"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      await runBurrow(["set", "B=2"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });

      const list = await runBurrow(["list", "--format", "json"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });
      expect(list.exitCode).toBe(0);

      const secrets = JSON.parse(list.stdout);
      expect(secrets).toHaveLength(2);

      const keyA = secrets.find((s: { key: string }) => s.key === "A");
      const keyB = secrets.find((s: { key: string }) => s.key === "B");

      expect(keyA).toBeDefined();
      expect(keyA.sourcePath).toBe(ctx.repo);
      expect(keyB).toBeDefined();
      expect(keyB.sourcePath).toBe(ctx.sub);
    });

    test("5. --path overrides cwd for set/unset/export", async () => {
      await runBurrow(["set", "A=1", "--path", ctx.repo], {
        cwd: ctx.root,
        configDir: ctx.configDir,
      });

      const get = await runBurrow(["get", "A", "--format", "json"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(get.exitCode).toBe(0);
      const parsed = JSON.parse(get.stdout);
      expect(parsed.key).toBe("A");

      const exportResult = await runBurrow(["export", "--format", "bash", "--path", ctx.repo], {
        cwd: ctx.root,
        configDir: ctx.configDir,
      });
      expect(exportResult.stdout).toContain("A=");
    });
  });

  describe("Tombstones / unset semantics", () => {
    test("6. Unset blocks inheritance", async () => {
      await runBurrow(["set", "API_KEY=parent"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      await runBurrow(["unset", "API_KEY"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });

      const get = await runBurrow(["get", "API_KEY"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });
      expect(get.exitCode).not.toBe(0);
      expect(get.stderr).toContain("not found");

      const list = await runBurrow(["list"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });
      expect(list.stdout).not.toContain("API_KEY");
    });

    test("7. Unset only affects that subtree", async () => {
      await runBurrow(["set", "API_KEY=parent"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      await runBurrow(["unset", "API_KEY"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });

      const get = await runBurrow(["get", "API_KEY", "--format", "json"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(get.exitCode).toBe(0);
      const parsed = JSON.parse(get.stdout);
      expect(parsed.sourcePath).toBe(ctx.repo);
    });

    test("8. Re-adding after unset works", async () => {
      await runBurrow(["set", "API_KEY=parent"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      await runBurrow(["unset", "API_KEY"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });
      await runBurrow(["set", "API_KEY=child"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });

      const get = await runBurrow(["get", "API_KEY", "--format", "json"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });
      expect(get.exitCode).toBe(0);
      const parsed = JSON.parse(get.stdout);
      expect(parsed.sourcePath).toBe(ctx.sub);
    });

    test("9. Unset idempotency", async () => {
      await runBurrow(["unset", "SOME_KEY"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const second = await runBurrow(["unset", "SOME_KEY"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(second.exitCode).toBe(0);
    });

    test("10. Unset of unknown key succeeds (no-op)", async () => {
      const result = await runBurrow(["unset", "NEVER_SET"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(result.exitCode).toBe(0);
    });
  });

  describe("Remove semantics", () => {
    test("Remove deletes a secret entry entirely", async () => {
      await runBurrow(["set", "API_KEY=secret"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const remove = await runBurrow(["remove", "API_KEY"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(remove.exitCode).toBe(0);
      expect(remove.stdout).toContain("Removed API_KEY");

      const get = await runBurrow(["get", "API_KEY"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(get.exitCode).not.toBe(0);
      expect(get.stderr).toContain("not found");
    });

    test("Remove of non-existent key reports not found", async () => {
      const result = await runBurrow(["remove", "NONEXISTENT"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("not found");
    });

    test("Remove restores inheritance from parent", async () => {
      // Set at parent level
      await runBurrow(["set", "API_KEY=parent"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      // Override at child level
      await runBurrow(["set", "API_KEY=child"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });

      // Verify child value takes precedence
      let get = await runBurrow(["get", "API_KEY", "--format", "json"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });
      expect(JSON.parse(get.stdout).value).toBe("child");

      // Remove child override
      await runBurrow(["remove", "API_KEY"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });

      // Now should inherit from parent
      get = await runBurrow(["get", "API_KEY", "--format", "json"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });
      expect(get.exitCode).toBe(0);
      const parsed = JSON.parse(get.stdout);
      expect(parsed.value).toBe("parent");
      expect(parsed.sourcePath).toBe(ctx.repo);
    });

    test("Remove with --path flag works", async () => {
      await runBurrow(["set", "KEY=value", "--path", ctx.repo], {
        cwd: ctx.root,
        configDir: ctx.configDir,
      });

      const remove = await runBurrow(["remove", "KEY", "--path", ctx.repo], {
        cwd: ctx.root,
        configDir: ctx.configDir,
      });
      expect(remove.exitCode).toBe(0);
      expect(remove.stdout).toContain("Removed KEY");

      const get = await runBurrow(["get", "KEY"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(get.exitCode).not.toBe(0);
    });

    test("Remove tombstone restores inheritance", async () => {
      // Set at parent level
      await runBurrow(["set", "API_KEY=parent"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      // Block at child level with unset
      await runBurrow(["unset", "API_KEY"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });

      // Verify key is blocked
      let get = await runBurrow(["get", "API_KEY"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });
      expect(get.exitCode).not.toBe(0);

      // Remove the tombstone
      await runBurrow(["remove", "API_KEY"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });

      // Now should inherit from parent
      get = await runBurrow(["get", "API_KEY", "--format", "json"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });
      expect(get.exitCode).toBe(0);
      expect(JSON.parse(get.stdout).value).toBe("parent");
    });

    test("Remove validates key format", async () => {
      const result = await runBurrow(["remove", "invalid-key"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid");
    });
  });

  describe("Export format correctness", () => {
    test("11. Shell export contains only safe statements", async () => {
      await runBurrow(["set", "KEY1=value1"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      await runBurrow(["set", "KEY2=value2"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const exportResult = await runBurrow(["export", "--format", "bash"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const lines = exportResult.stdout.split("\n").filter(Boolean);
      for (const line of lines) {
        expect(line).toMatch(/^export [A-Za-z_][A-Za-z0-9_]*='.*'$/);
      }
    });

    test("12. Shell escaping works - spaces", async () => {
      await runBurrow(["set", "SPACED=hello world"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const exportResult = await runBurrow(["export", "--format", "bash"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(exportResult.stdout).toBe("export SPACED='hello world'");

      const proc = Bun.spawn(["bash", "-c", `${exportResult.stdout}; echo "$SPACED"`], {
        stdout: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      expect(output.trim()).toBe("hello world");
    });

    test("12. Shell escaping works - single quotes", async () => {
      await runBurrow(["set", "QUOTED=it's fine"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const exportResult = await runBurrow(["export", "--format", "bash"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(exportResult.stdout).toContain("QUOTED=");

      const proc = Bun.spawn(["bash", "-c", `${exportResult.stdout}; echo "$QUOTED"`], {
        stdout: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      expect(output.trim()).toBe("it's fine");
    });

    test("12. Shell escaping works - special characters", async () => {
      await runBurrow(["set", "SPECIAL=$HOME and `cmd`"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const exportResult = await runBurrow(["export", "--format", "bash"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(exportResult.stdout).toContain("SPECIAL=");

      const proc = Bun.spawn(["bash", "-c", `${exportResult.stdout}; echo "$SPECIAL"`], {
        stdout: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      expect(output.trim()).toBe("$HOME and `cmd`");
    });

    test("13. dotenv format correctness", async () => {
      await runBurrow(["set", "KEY=value"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const exportResult = await runBurrow(["export", "--format", "dotenv"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(exportResult.stdout).toMatch(/^[A-Z_][A-Z0-9_]*=".*"$/);
    });

    test("13. dotenv format rejects multiline values", async () => {
      await runBurrow(["set", "MULTI=line1\nline2"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const exportResult = await runBurrow(["export", "--format", "dotenv"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(exportResult.exitCode).not.toBe(0);
      expect(exportResult.stderr).toContain("newline");
    });

    test("14. json export correctness", async () => {
      await runBurrow(["set", "KEY=value"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const exportResult = await runBurrow(["export", "--format", "json"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(exportResult.exitCode).toBe(0);
      const parsed = JSON.parse(exportResult.stdout);
      expect(parsed.KEY).toBe("value");
    });

    test("15. Export reflects resolution + tombstones", async () => {
      await runBurrow(["set", "API_KEY=parent"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      await runBurrow(["unset", "API_KEY"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });

      const exportResult = await runBurrow(["export", "--format", "json"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });

      const parsed = JSON.parse(exportResult.stdout);
      expect(parsed.API_KEY).toBeUndefined();
    });
  });

  describe("List/get UX + exit codes", () => {
    test("16. Get shows actual value", async () => {
      await runBurrow(["set", "SECRET=mysecretvalue"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const result = await runBurrow(["get", "SECRET"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("mysecretvalue");
    });

    test("17. Get missing key returns non-zero exit", async () => {
      const result = await runBurrow(["get", "MISSING_KEY"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not found");
    });

    test("18. List shows source path", async () => {
      await runBurrow(["set", "PARENT_KEY=p"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      await runBurrow(["set", "CHILD_KEY=c"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });

      const list = await runBurrow(["list", "--format", "json"], {
        cwd: ctx.sub,
        configDir: ctx.configDir,
      });

      const secrets = JSON.parse(list.stdout);
      const parent = secrets.find((s: { key: string }) => s.key === "PARENT_KEY");
      const child = secrets.find((s: { key: string }) => s.key === "CHILD_KEY");

      expect(parent.sourcePath).toBe(ctx.repo);
      expect(child.sourcePath).toBe(ctx.sub);
    });
  });

  describe("Path canonicalization / matching", () => {
    test("19. Ancestor matching uses canonical absolute paths", async () => {
      const relativePath = join(ctx.repo, "..", "repo");

      await runBurrow(["set", "KEY=value", "--path", relativePath], {
        cwd: ctx.root,
        configDir: ctx.configDir,
      });

      const get = await runBurrow(["get", "KEY", "--format", "json"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(get.exitCode).toBe(0);
      const parsed = JSON.parse(get.stdout);
      expect(parsed.key).toBe("KEY");
    });

    test("20. Prefix-collision safety", async () => {
      const repo2 = join(ctx.root, "repo2");
      await mkdir(repo2, { recursive: true });

      await runBurrow(["set", "KEY=repo1"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const get = await runBurrow(["get", "KEY"], {
        cwd: repo2,
        configDir: ctx.configDir,
      });

      expect(get.exitCode).not.toBe(0);
    });

    test("21. Symlink resolution", async () => {
      const linkPath = join(ctx.root, "repo-link");
      await symlink(ctx.repo, linkPath);

      await runBurrow(["set", "KEY=value"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const get = await runBurrow(["get", "KEY", "--format", "json"], {
        cwd: linkPath,
        configDir: ctx.configDir,
      });

      expect(get.exitCode).toBe(0);
      const parsed = JSON.parse(get.stdout);
      expect(parsed.key).toBe("KEY");
    });
  });

  describe("Concurrency / robustness", () => {
    test("22. Store file is valid SQLite after set", async () => {
      await runBurrow(["set", "KEY=value"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const { Database } = await import("bun:sqlite");
      const db = new Database(join(ctx.configDir, "store.db"));
      const version = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(version.user_version).toBe(1);
      db.close();
    });

    test("23. Repeated sets don't corrupt store", async () => {
      for (let i = 0; i < 10; i++) {
        await runBurrow(["set", `KEY=value${i}`], {
          cwd: ctx.repo,
          configDir: ctx.configDir,
        });
      }

      const { Database } = await import("bun:sqlite");
      const db = new Database(join(ctx.configDir, "store.db"));
      const version = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(version.user_version).toBe(1);
      db.close();

      const get = await runBurrow(["get", "KEY"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(get.exitCode).toBe(0);
    });
  });

  describe("Validation and error handling", () => {
    test("24. Invalid key names rejected - starts with number", async () => {
      const result = await runBurrow(["set", "1BAD=value"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid");
    });

    test("24. Invalid key names rejected - contains hyphen", async () => {
      const result = await runBurrow(["set", "BAD-KEY=value"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid");
    });

    test("24. Lowercase key names are accepted", async () => {
      const result = await runBurrow(["set", "lowercase_key=value"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).toBe(0);

      // Verify the value was stored
      const getResult = await runBurrow(["get", "lowercase_key"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      expect(getResult.exitCode).toBe(0);
      expect(getResult.stdout.trim()).toBe("value");
    });

    test("25. Invalid KEY=VALUE syntax - no equals", async () => {
      const result = await runBurrow(["set", "JUSTKEY"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("KEY=VALUE");
    });

    test("25. Invalid KEY=VALUE syntax - empty key", async () => {
      const result = await runBurrow(["set", "=VALUE"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).not.toBe(0);
    });

    test("26. Bad format flag", async () => {
      const result = await runBurrow(["export", "--format", "nope"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("invalid");
    });

    test("27. Non-existent --path creates scope anyway", async () => {
      const nonExistent = join(ctx.root, "does-not-exist");

      const result = await runBurrow(["set", "KEY=value", "--path", nonExistent], {
        cwd: ctx.root,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).toBe(0);
    });
  });

  describe("Config dir isolation", () => {
    test("29. BURROW_CONFIG_DIR override works", async () => {
      await runBurrow(["set", "ISOLATED=yes"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const { Database } = await import("bun:sqlite");
      const db = new Database(join(ctx.configDir, "store.db"));
      const row = db.query("SELECT key FROM secrets WHERE key = 'ISOLATED'").get() as { key: string } | null;
      expect(row?.key).toBe("ISOLATED");
      db.close();

      const altConfigDir = join(ctx.workspaceDir, "alt-config");
      await mkdir(altConfigDir, { recursive: true });

      const get = await runBurrow(["get", "ISOLATED"], {
        cwd: ctx.repo,
        configDir: altConfigDir,
      });

      expect(get.exitCode).not.toBe(0);
    });
  });

  describe("Edge cases", () => {
    test("Empty value is allowed", async () => {
      await runBurrow(["set", "EMPTY="], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const get = await runBurrow(["get", "EMPTY", "--format", "json"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(get.exitCode).toBe(0);
      const parsed = JSON.parse(get.stdout);
      expect(parsed.key).toBe("EMPTY");
    });

    test("Value with equals sign", async () => {
      await runBurrow(["set", "EQUATION=a=b=c"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const exportResult = await runBurrow(["export", "--format", "json"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(exportResult.exitCode).toBe(0);
      const parsed = JSON.parse(exportResult.stdout);
      expect(parsed.EQUATION).toBe("a=b=c");
    });

    test("List empty directory shows message", async () => {
      const list = await runBurrow(["list"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("No secrets found");
    });

    test("Export empty directory produces empty output", async () => {
      const exportResult = await runBurrow(["export", "--format", "shell"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(exportResult.exitCode).toBe(0);
      expect(exportResult.stdout).toBe("");
    });

    test("Underscore-only key is valid", async () => {
      await runBurrow(["set", "_=value"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const exportResult = await runBurrow(["export", "--format", "json"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(exportResult.exitCode).toBe(0);
      const parsed = JSON.parse(exportResult.stdout);
      expect(parsed._).toBe("value");
    });

    test("Key with numbers is valid", async () => {
      await runBurrow(["set", "API_KEY_V2=value"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const exportResult = await runBurrow(["export", "--format", "json"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(exportResult.exitCode).toBe(0);
      const parsed = JSON.parse(exportResult.stdout);
      expect(parsed.API_KEY_V2).toBe("value");
    });
  });

  describe("Redaction flag", () => {
    test("Get command with --redact flag in plain format", async () => {
      await runBurrow(["set", "SECRET=mysecretvalue"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const result = await runBurrow(["get", "SECRET", "--redact"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("[REDACTED]");
      expect(result.stdout).not.toContain("mysecretvalue");
    });

    test("Get command with --redact flag in JSON format", async () => {
      await runBurrow(["set", "SECRET=mysecretvalue"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const result = await runBurrow(["get", "SECRET", "--format", "json", "--redact"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.key).toBe("SECRET");
      expect(parsed.value).toBe("[REDACTED]");
      expect(parsed.sourcePath).toBe(ctx.repo);
      expect(result.stdout).not.toContain("mysecretvalue");
    });

    test("Get command without --redact flag shows actual value", async () => {
      await runBurrow(["set", "SECRET=mysecretvalue"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const result = await runBurrow(["get", "SECRET"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("mysecretvalue");
    });

    test("List command with --redact flag in plain format", async () => {
      await runBurrow(["set", "SECRET1=value1"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      await runBurrow(["set", "SECRET2=value2"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const result = await runBurrow(["list", "--redact"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SECRET1=[REDACTED]");
      expect(result.stdout).toContain("SECRET2=[REDACTED]");
      expect(result.stdout).not.toContain("value1");
      expect(result.stdout).not.toContain("value2");
    });

    test("List command with --redact flag in JSON format", async () => {
      await runBurrow(["set", "SECRET1=value1"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });
      await runBurrow(["set", "SECRET2=value2"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const result = await runBurrow(["list", "--format", "json", "--redact"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveLength(2);
      
      const secret1 = parsed.find((s: { key: string }) => s.key === "SECRET1");
      const secret2 = parsed.find((s: { key: string }) => s.key === "SECRET2");
      
      expect(secret1.value).toBe("[REDACTED]");
      expect(secret2.value).toBe("[REDACTED]");
      expect(result.stdout).not.toContain("value1");
      expect(result.stdout).not.toContain("value2");
    });

    test("List command without --redact flag shows actual values", async () => {
      await runBurrow(["set", "SECRET1=value1"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      const result = await runBurrow(["list"], {
        cwd: ctx.repo,
        configDir: ctx.configDir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SECRET1=value1");
    });
  });
});
