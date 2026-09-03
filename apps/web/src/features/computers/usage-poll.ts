export async function waitForUsageScanResult<T extends { scanId: string; status: string }>(
  scanId: string,
  read: () => Promise<T | undefined>,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  let result = await read();
  for (
    let attempt = 0;
    attempt < 150 && (result?.scanId !== scanId || result.status === "pending");
    attempt += 1
  ) {
    await sleep(100);
    result = await read();
  }
  if (!result || result.scanId !== scanId || result.status === "pending")
    throw new Error("usage scan timed out");
  return result;
}
