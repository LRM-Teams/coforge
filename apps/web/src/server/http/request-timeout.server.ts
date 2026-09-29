/**
 * Lets this request run for up to `seconds` before Bun closes its connection as idle. `Bun.serve`
 * closes a connection after 10 s without traffic, a pending response included, unless
 * `server.timeout(request, seconds)` says otherwise (https://bun.com/docs/runtime/http/server).
 * The srvx Bun adapter Nitro serves through puts that server on `request.runtime.bun.server`;
 * without one (Vite dev) this does nothing and answers `false`.
 */
export function extendRequestTimeout(request: Request, seconds: number): boolean {
  const server = (request as { runtime?: { bun?: { server?: Partial<BunTimeout> } } }).runtime?.bun
    ?.server;
  if (typeof server?.timeout !== "function") return false;
  server.timeout(request, seconds);
  return true;
}

type BunTimeout = { timeout(request: Request, seconds: number): void };
