const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export function ensureTestEncryptionKey(): void {
  process.env["BURROW_ENCRYPTION_KEY"] = TEST_ENCRYPTION_KEY;
}
