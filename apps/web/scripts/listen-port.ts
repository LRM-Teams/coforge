export const FORBIDDEN_LOCAL_PORT = 3000;
export const DEFAULT_FRONTEND_PORT = 8788;
export const DEFAULT_BACKEND_PORT = 8789;

export function readListenPort(env: Record<string, string | undefined>, fallback: number): number {
  const raw = env.PORT?.trim();
  const port = raw ? Number(raw) : fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PORT: ${raw ?? fallback}`);
  }
  if (port === FORBIDDEN_LOCAL_PORT) {
    throw new Error("local Web scripts must not use port 3000");
  }
  return port;
}
