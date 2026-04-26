import { describe, expect, test } from "bun:test";
import { parseDotenv } from "../src/core/importer.ts";

describe("dotenv importer", () => {
  test("parses comments, blank lines, export prefix, and quoted values", () => {
    const imported = parseDotenv(`
# ignored
export API_KEY=abc123
DATABASE_URL="postgres://user:pass@example.com/db"
MESSAGE='hello world'
URL=https://example.com/#fragment
INLINE_COMMENT=value # ignored
EMPTY=
`);

    expect(imported).toEqual([
      { key: "API_KEY", value: "abc123" },
      { key: "DATABASE_URL", value: "postgres://user:pass@example.com/db" },
      { key: "MESSAGE", value: "hello world" },
      { key: "URL", value: "https://example.com/#fragment" },
      { key: "INLINE_COMMENT", value: "value" },
      { key: "EMPTY", value: "" },
    ]);
  });

  test("uses the last value when a key appears multiple times", () => {
    const imported = parseDotenv("API_KEY=first\nAPI_KEY=second");

    expect(imported).toEqual([{ key: "API_KEY", value: "second" }]);
  });

  test("decodes common double-quoted escape sequences", () => {
    const imported = parseDotenv(String.raw`QUOTED="line1\nline2\t\"quoted\""`);

    expect(imported).toEqual([{ key: "QUOTED", value: 'line1\nline2\t"quoted"' }]);
  });

  test("throws for invalid dotenv syntax", () => {
    expect(() => parseDotenv("MISSING_EQUALS")).toThrow("expected KEY=VALUE");
    expect(() => parseDotenv("BAD-KEY=value")).toThrow("Invalid environment variable key");
    expect(() => parseDotenv('API_KEY="unterminated')).toThrow("unterminated quoted value");
  });
});
