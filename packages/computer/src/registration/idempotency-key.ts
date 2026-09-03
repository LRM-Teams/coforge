/** Low-level Bun adapter for the application registration-key port. */
export function registrationIdempotencyKey(serverUrl: string, value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${serverUrl}\0${value}`);
  return hasher.digest("hex");
}
