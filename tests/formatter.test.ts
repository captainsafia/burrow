import { describe, expect, test } from "bun:test";
import {
  validateEnvKey,
  assertValidEnvKey,
  formatShell,
  formatDotenv,
  formatJson,
  format,
} from "../src/core/formatter.ts";
import type { ResolvedSecret } from "../src/core/resolver.ts";

function createSecretsMap(
  entries: Array<[string, string, string]>
): Map<string, ResolvedSecret> {
  const map = new Map<string, ResolvedSecret>();
  for (const [key, value, sourcePath] of entries) {
    map.set(key, { key, value, sourcePath });
  }
  return map;
}

describe("validateEnvKey", () => {
  test("accepts valid uppercase keys", () => {
    expect(validateEnvKey("MY_KEY")).toBe(true);
    expect(validateEnvKey("API_KEY")).toBe(true);
    expect(validateEnvKey("DATABASE_URL")).toBe(true);
  });

  test("accepts keys starting with underscore", () => {
    expect(validateEnvKey("_PRIVATE")).toBe(true);
    expect(validateEnvKey("_")).toBe(true);
  });

  test("accepts keys with numbers", () => {
    expect(validateEnvKey("KEY1")).toBe(true);
    expect(validateEnvKey("API_KEY_V2")).toBe(true);
  });

  test("rejects keys starting with numbers", () => {
    expect(validateEnvKey("1KEY")).toBe(false);
    expect(validateEnvKey("123")).toBe(false);
  });

  test("rejects lowercase keys", () => {
    expect(validateEnvKey("my_key")).toBe(false);
    expect(validateEnvKey("MyKey")).toBe(false);
  });

  test("rejects keys with special characters", () => {
    expect(validateEnvKey("MY-KEY")).toBe(false);
    expect(validateEnvKey("MY.KEY")).toBe(false);
    expect(validateEnvKey("MY KEY")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(validateEnvKey("")).toBe(false);
  });
});

describe("assertValidEnvKey", () => {
  test("does not throw for valid keys", () => {
    expect(() => assertValidEnvKey("VALID_KEY")).not.toThrow();
  });

  test("throws for invalid keys", () => {
    expect(() => assertValidEnvKey("invalid")).toThrow(
      "Invalid environment variable key"
    );
  });
});

describe("formatShell", () => {
  test("formats empty map as empty string", () => {
    const secrets = new Map<string, ResolvedSecret>();
    expect(formatShell(secrets)).toBe("");
  });

  test("formats single secret", () => {
    const secrets = createSecretsMap([["MY_KEY", "my_value", "/path"]]);
    expect(formatShell(secrets)).toBe("export MY_KEY='my_value'");
  });

  test("formats multiple secrets sorted by key", () => {
    const secrets = createSecretsMap([
      ["ZEBRA", "z", "/path"],
      ["ALPHA", "a", "/path"],
    ]);
    const output = formatShell(secrets);
    const lines = output.split("\n");
    expect(lines[0]).toBe("export ALPHA='a'");
    expect(lines[1]).toBe("export ZEBRA='z'");
  });

  test("escapes single quotes in values", () => {
    const secrets = createSecretsMap([["KEY", "it's a test", "/path"]]);
    expect(formatShell(secrets)).toBe(`export KEY='it'"'"'s a test'`);
  });

  test("handles values with multiple single quotes", () => {
    const secrets = createSecretsMap([["KEY", "a'b'c", "/path"]]);
    expect(formatShell(secrets)).toBe(`export KEY='a'"'"'b'"'"'c'`);
  });

  test("handles newlines in values", () => {
    const secrets = createSecretsMap([["KEY", "line1\nline2", "/path"]]);
    expect(formatShell(secrets)).toBe("export KEY='line1\nline2'");
  });

  test("throws for invalid key", () => {
    const secrets = new Map<string, ResolvedSecret>();
    secrets.set("invalid-key", {
      key: "invalid-key",
      value: "value",
      sourcePath: "/path",
    });
    expect(() => formatShell(secrets)).toThrow("Invalid environment variable key");
  });
});

describe("formatDotenv", () => {
  test("formats empty map as empty string", () => {
    const secrets = new Map<string, ResolvedSecret>();
    expect(formatDotenv(secrets)).toBe("");
  });

  test("formats single secret with double quotes", () => {
    const secrets = createSecretsMap([["MY_KEY", "my_value", "/path"]]);
    expect(formatDotenv(secrets)).toBe('MY_KEY="my_value"');
  });

  test("escapes double quotes in values", () => {
    const secrets = createSecretsMap([["KEY", 'say "hello"', "/path"]]);
    expect(formatDotenv(secrets)).toBe('KEY="say \\"hello\\""');
  });

  test("escapes backslashes in values", () => {
    const secrets = createSecretsMap([["KEY", "path\\to\\file", "/path"]]);
    expect(formatDotenv(secrets)).toBe('KEY="path\\\\to\\\\file"');
  });

  test("throws for values with newlines", () => {
    const secrets = createSecretsMap([["KEY", "line1\nline2", "/path"]]);
    expect(() => formatDotenv(secrets)).toThrow("value contains newlines");
  });

  test("formats multiple secrets sorted by key", () => {
    const secrets = createSecretsMap([
      ["ZEBRA", "z", "/path"],
      ["ALPHA", "a", "/path"],
    ]);
    const output = formatDotenv(secrets);
    const lines = output.split("\n");
    expect(lines[0]).toBe('ALPHA="a"');
    expect(lines[1]).toBe('ZEBRA="z"');
  });
});

describe("formatJson", () => {
  test("formats empty map as empty object", () => {
    const secrets = new Map<string, ResolvedSecret>();
    expect(JSON.parse(formatJson(secrets))).toEqual({});
  });

  test("formats secrets as key-value pairs", () => {
    const secrets = createSecretsMap([
      ["KEY1", "value1", "/path"],
      ["KEY2", "value2", "/path"],
    ]);
    const output = JSON.parse(formatJson(secrets));
    expect(output).toEqual({
      KEY1: "value1",
      KEY2: "value2",
    });
  });

  test("includes sources when requested", () => {
    const secrets = createSecretsMap([["KEY", "value", "/my/path"]]);
    const output = JSON.parse(formatJson(secrets, true));
    expect(output).toEqual({
      KEY: {
        value: "value",
        sourcePath: "/my/path",
      },
    });
  });

  test("handles special characters in values", () => {
    const secrets = createSecretsMap([["KEY", 'quotes"and\nnewlines', "/path"]]);
    const output = JSON.parse(formatJson(secrets));
    expect(output.KEY).toBe('quotes"and\nnewlines');
  });
});

describe("format", () => {
  test("dispatches to shell formatter", () => {
    const secrets = createSecretsMap([["KEY", "value", "/path"]]);
    expect(format(secrets, "shell")).toBe("export KEY='value'");
  });

  test("dispatches to dotenv formatter", () => {
    const secrets = createSecretsMap([["KEY", "value", "/path"]]);
    expect(format(secrets, "dotenv")).toBe('KEY="value"');
  });

  test("dispatches to json formatter", () => {
    const secrets = createSecretsMap([["KEY", "value", "/path"]]);
    expect(JSON.parse(format(secrets, "json"))).toEqual({ KEY: "value" });
  });

  test("throws for unknown format", () => {
    const secrets = new Map<string, ResolvedSecret>();
    expect(() => format(secrets, "xml" as never)).toThrow("Unknown format");
  });
});
