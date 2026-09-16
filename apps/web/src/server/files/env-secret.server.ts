import { readFileSync } from "node:fs";

/**
 * Reads one secret from either an inline environment variable `NAME` or a Docker-secret file
 * path in `NAME_FILE` (both trimmed). At most one of the two may be set; neither is required.
 * Shared by `file-storage.server.ts` and `file-delivery.server.ts` so the `*_FILE` convention is
 * defined once. `fail` reports a config error in the caller's own error type.
 */
export function readEnvSecret(
  env: NodeJS.ProcessEnv,
  name: string,
  fail: (message: string) => never,
): string | undefined {
  const inlineValue = env[name]?.trim();
  const fileName = `${name}_FILE`;
  const filePath = env[fileName]?.trim();
  if (inlineValue && filePath) {
    fail(`${name} and ${fileName} cannot both be set`);
  }
  if (!filePath) return inlineValue || undefined;
  try {
    return readFileSync(filePath, "utf8").trim() || undefined;
  } catch {
    fail(`${fileName} could not be read`);
  }
}
