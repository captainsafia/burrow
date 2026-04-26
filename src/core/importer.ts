import { assertValidEnvKey } from "./formatter.ts";

export type ImportFormat = "dotenv";

export interface ImportedSecret {
  key: string;
  value: string;
}

export interface ParseImportOptions {
  format: ImportFormat;
}

type ImportParser = (content: string) => ImportedSecret[];

function stripInlineComment(value: string): string {
  return value.replace(/\s+#.*$/, "").trim();
}

function parseDoubleQuotedValue(text: string, lineNumber: number): string {
  let value = "";

  for (let index = 1; index < text.length; index++) {
    const char = text[index];

    if (char === undefined) {
      break;
    }

    if (char === '"') {
      const trailing = text.slice(index + 1).trim();
      if (trailing !== "" && !trailing.startsWith("#")) {
        throw new Error(`Invalid dotenv syntax on line ${lineNumber}: unexpected content after quoted value`);
      }
      return value;
    }

    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) {
        value += char;
        continue;
      }

      switch (next) {
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        case "\\":
          value += "\\";
          break;
        case '"':
          value += '"';
          break;
        default:
          value += next;
          break;
      }
      index++;
      continue;
    }

    value += char;
  }

  throw new Error(`Invalid dotenv syntax on line ${lineNumber}: unterminated quoted value`);
}

function parseSingleQuotedValue(text: string, lineNumber: number): string {
  const closingIndex = text.indexOf("'", 1);
  if (closingIndex === -1) {
    throw new Error(`Invalid dotenv syntax on line ${lineNumber}: unterminated quoted value`);
  }

  const trailing = text.slice(closingIndex + 1).trim();
  if (trailing !== "" && !trailing.startsWith("#")) {
    throw new Error(`Invalid dotenv syntax on line ${lineNumber}: unexpected content after quoted value`);
  }

  return text.slice(1, closingIndex);
}

export function parseDotenv(content: string): ImportedSecret[] {
  const secrets = new Map<string, string>();
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    let line = rawLine.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trimStart();
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      throw new Error(`Invalid dotenv syntax on line ${lineNumber}: expected KEY=VALUE`);
    }

    const key = line.slice(0, equalsIndex).trim();
    assertValidEnvKey(key);

    const valueText = line.slice(equalsIndex + 1).trimStart();
    let value: string;

    if (valueText.startsWith('"')) {
      value = parseDoubleQuotedValue(valueText, lineNumber);
    } else if (valueText.startsWith("'")) {
      value = parseSingleQuotedValue(valueText, lineNumber);
    } else {
      value = stripInlineComment(valueText);
    }

    secrets.set(key, value);
  }

  return Array.from(secrets, ([key, value]) => ({ key, value }));
}

const IMPORT_PARSERS: Record<ImportFormat, ImportParser> = {
  dotenv: parseDotenv,
};

export function parseImport(content: string, options: ParseImportOptions): ImportedSecret[] {
  const parser = IMPORT_PARSERS[options.format];
  if (!parser) {
    throw new Error(`Unsupported import format: ${options.format}`);
  }

  return parser(content);
}
