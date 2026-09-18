/**
 * Polls `read` until it reports the exact scan this call started — never a stale one already in
 * the cache, and never the "pending" placeholder for a scan that hasn't finished yet. The previous
 * result stays whatever `read` returns while this waits, so a slow scan never has to blank the
 * caller's display back to empty.
 */
export async function waitForUsageScanResult<T extends { result?: { scanId: string } }>(
  scanId: string,
  read: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  let current = await read();
  for (let attempt = 0; attempt < 150 && current.result?.scanId !== scanId; attempt += 1) {
    await sleep(100);
    current = await read();
  }
  if (current.result?.scanId !== scanId) throw new Error("usage scan timed out");
  return current;
}
