const SAFE_INHERITED_ENVIRONMENT = [
  "HOME",
  "PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
] as const;

export function agentEnvironment(
  declared: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of SAFE_INHERITED_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...declared };
}
