/**
 * Makes `Temporal` available before the app runs. Bun and current Chrome, Edge and Firefox ship it
 * natively and are left alone; elsewhere (Safari today) the polyfill is loaded on demand, so only
 * those browsers download it. `temporal-polyfill/global` itself also skips installing when a
 * native `Temporal` exists. Drop this once every supported browser ships Temporal.
 */
export async function ensureTemporal(): Promise<void> {
  if ("Temporal" in globalThis) return;
  await import("temporal-polyfill/global");
}
