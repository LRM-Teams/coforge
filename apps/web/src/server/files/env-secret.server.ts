/**
 * Reads one secret from either an inline environment variable `NAME` or a Docker-secret file
 * path in `NAME_FILE` (both trimmed). At most one of the two may be set; neither is required.
 * Shared by file storage and file delivery so the `*_FILE` convention is defined once.
 * `fail` reports a config error in the caller's own error type.
 *
 * File contents use `Bun.file().text()` — the official recommended file read — so a secret
 * mount cannot block the event loop the way `readFileSync` does.
 * https://bun.com/docs/runtime/file-io
 */
export async function readEnvSecret(
  env: NodeJS.ProcessEnv,
  name: string,
  fail: (message: string) => never,
): Promise<string | undefined> {
  const inlineValue = env[name]?.trim();
  const fileName = `${name}_FILE`;
  const filePath = env[fileName]?.trim();
  if (inlineValue && filePath) {
    fail(`${name} and ${fileName} cannot both be set`);
  }
  if (!filePath) return inlineValue || undefined;
  try {
    return (await Bun.file(filePath).text()).trim() || undefined;
  } catch {
    fail(`${fileName} could not be read`);
  }
}
