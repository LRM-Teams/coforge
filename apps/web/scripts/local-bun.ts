import { dirname } from "node:path";

export function bunExecutable(): string {
  return process.execPath;
}

export function pathWithBun(env?: { PATH?: string }): string {
  const bunDir = dirname(process.execPath);
  const path = env?.PATH ?? process.env.PATH ?? "";
  if (path.split(":").includes(bunDir)) {
    return path;
  }
  return `${bunDir}:${path}`;
}

export function bunChildEnv(
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  return {
    ...process.env,
    PATH: pathWithBun(),
    ...extra,
  };
}
