import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isWindows } from "../platform/index.ts";

const ENCRYPTION_SERVICE = "burrow";
const ENCRYPTION_KEY_NAME_PREFIX = "store-key";
const ENCRYPTION_KEY_FILE = "store.key";
const ENCRYPTION_KEY_BYTES = 32;
const ENCRYPTION_IV_BYTES = 12;
const ENCRYPTION_AUTH_TAG_BYTES = 16;

const ANY_ENCRYPTED_VALUE_PREFIX = "burrow:enc:";
const ENCRYPTED_VALUE_PREFIX_V1 = "burrow:enc:v1:";

export class SecretValueEncryptor {
  private readonly keySecretName: string;
  private readonly fallbackKeyPath: string;
  private keyPromise?: Promise<Buffer>;

  constructor(private readonly configDir: string) {
    const configHash = createHash("sha256").update(configDir).digest("hex");
    this.keySecretName = `${ENCRYPTION_KEY_NAME_PREFIX}-${configHash}`;
    this.fallbackKeyPath = join(configDir, ENCRYPTION_KEY_FILE);
  }

  isEncryptedValue(value: string): boolean {
    return value.startsWith(ANY_ENCRYPTED_VALUE_PREFIX);
  }

  async encrypt(plainText: string): Promise<string> {
    const key = await this.getOrCreateKey();
    const iv = randomBytes(ENCRYPTION_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plainText, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return `${ENCRYPTED_VALUE_PREFIX_V1}${iv.toString("base64")}.${authTag.toString("base64")}.${ciphertext.toString("base64")}`;
  }

  async decrypt(value: string): Promise<string> {
    if (!this.isEncryptedValue(value)) {
      return value;
    }

    if (!value.startsWith(ENCRYPTED_VALUE_PREFIX_V1)) {
      throw new Error("Unsupported encrypted value format in secrets store");
    }

    const encoded = value.slice(ENCRYPTED_VALUE_PREFIX_V1.length);
    const [ivBase64, authTagBase64, ciphertextBase64, ...rest] = encoded.split(".");
    if (
      rest.length > 0
      || ivBase64 === undefined
      || authTagBase64 === undefined
      || ciphertextBase64 === undefined
    ) {
      throw new Error("Malformed encrypted value in secrets store");
    }

    const iv = Buffer.from(ivBase64, "base64");
    const authTag = Buffer.from(authTagBase64, "base64");
    const ciphertext = Buffer.from(ciphertextBase64, "base64");

    if (iv.byteLength !== ENCRYPTION_IV_BYTES) {
      throw new Error("Malformed encrypted value (invalid IV length)");
    }

    if (authTag.byteLength !== ENCRYPTION_AUTH_TAG_BYTES) {
      throw new Error("Malformed encrypted value (invalid auth tag length)");
    }

    const key = await this.getOrCreateKey();
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch {
      throw new Error(
        "Failed to decrypt value from secrets store. The encryption key may be unavailable or has changed."
      );
    }
  }

  private async getOrCreateKey(): Promise<Buffer> {
    this.keyPromise ??= this.loadOrCreateKey();
    return this.keyPromise;
  }

  private async loadOrCreateKey(): Promise<Buffer> {
    // If an on-disk fallback key exists, keep using it to avoid key drift.
    const fallbackKey = await this.readFallbackKey();
    if (fallbackKey) {
      await this.tryStoreInBunSecrets(fallbackKey);
      return fallbackKey;
    }

    const bunSecretsKey = await this.readKeyFromBunSecrets();
    if (bunSecretsKey) {
      return bunSecretsKey;
    }

    const generatedKey = randomBytes(ENCRYPTION_KEY_BYTES);
    const storedInBunSecrets = await this.tryStoreInBunSecrets(generatedKey);
    if (!storedInBunSecrets) {
      await this.writeFallbackKey(generatedKey);
    }

    return generatedKey;
  }

  private async readKeyFromBunSecrets(): Promise<Buffer | undefined> {
    let keyMaterial: string | null;

    try {
      keyMaterial = await Bun.secrets.get({
        service: ENCRYPTION_SERVICE,
        name: this.keySecretName,
      });
    } catch {
      return undefined;
    }

    if (keyMaterial === null) {
      return undefined;
    }

    return parseKeyMaterial(keyMaterial, "Bun.secrets");
  }

  private async tryStoreInBunSecrets(key: Buffer): Promise<boolean> {
    try {
      await Bun.secrets.set({
        service: ENCRYPTION_SERVICE,
        name: this.keySecretName,
        value: key.toString("base64"),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async readFallbackKey(): Promise<Buffer | undefined> {
    try {
      const keyMaterial = await readFile(this.fallbackKeyPath, "utf8");
      return parseKeyMaterial(keyMaterial, this.fallbackKeyPath);
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: string }).code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  private async writeFallbackKey(key: Buffer): Promise<void> {
    await writeFile(this.fallbackKeyPath, `${key.toString("base64")}\n`, "utf8");
    if (!isWindows()) {
      await chmod(this.fallbackKeyPath, 0o600);
    }
  }
}

function parseKeyMaterial(value: string, source: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Encryption key in ${source} is empty`);
  }

  const key = Buffer.from(trimmed, "base64");
  if (key.byteLength !== ENCRYPTION_KEY_BYTES) {
    throw new Error(
      `Encryption key in ${source} must be ${ENCRYPTION_KEY_BYTES} bytes`
    );
  }

  return key;
}
