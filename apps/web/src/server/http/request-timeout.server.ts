/**
 * Lets this request run for up to `seconds` before Bun closes its connection as idle. `Bun.serve`
 * closes a connection after 10 s without traffic, a pending response included, unless
 * `server.timeout(request, seconds)` says otherwise (https://bun.com/docs/runtime/http/server).
 * The srvx Bun adapter Nitro serves through puts that server on `request.runtime.bun.server`;
 * without one (Vite dev) this does nothing and answers `false`.
 */
export function extendRequestTimeout(request: Request, seconds: number): boolean {
  const runtime: unknown = Reflect.get(request, "runtime");
  const bun: unknown =
    runtime && typeof runtime === "object" ? Reflect.get(runtime, "bun") : undefined;
  const server: unknown = bun && typeof bun === "object" ? Reflect.get(bun, "server") : undefined;
  const timeout: unknown =
    server && typeof server === "object" ? Reflect.get(server, "timeout") : undefined;
  if (typeof timeout !== "function") return false;
  Reflect.apply(timeout, server, [request, seconds]);
  return true;
}
