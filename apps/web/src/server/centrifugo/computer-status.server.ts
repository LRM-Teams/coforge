const DEFAULT_WATCHDOG_MS = 90_000;

type Entry = { online: boolean; lastSeen: number };
const statuses = new Map<string, Entry>();

// Centrifugo's proxy does not provide the Web process a connection-local
// disconnect callback. DaemonConnection reports healthy connects, while this
// volatile lease expires conservatively when no refresh arrives. It is not a
// PostgreSQL presence record and must not be treated as one.

export function computerWatchdogMs(env = process.env): number {
  const value = Number(env.COFORGE_COMPUTER_WATCHDOG_SECONDS ?? 90);
  return Number.isFinite(value) && value > 0 ? value * 1000 : DEFAULT_WATCHDOG_MS;
}

export function setComputerStatus(
  workspaceId: string,
  computerId: string,
  online: boolean,
  now = Date.now(),
) {
  statuses.set(`${workspaceId}:${computerId}`, { online, lastSeen: now });
}

export function getComputerStatus(workspaceId: string, computerId: string, now = Date.now()) {
  const entry = statuses.get(`${workspaceId}:${computerId}`);
  return { online: Boolean(entry?.online && now - entry.lastSeen < computerWatchdogMs()) };
}
