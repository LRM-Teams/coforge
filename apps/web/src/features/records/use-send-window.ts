import { useEffect, useState } from "react";

import {
  formatSendWindowCountdown,
  isWeeklySendArmed,
  weeklySendWindow,
} from "./weekly-send-window";

export type SendWindowInput = {
  alreadySent: boolean;
  sendWeekday: number;
  sendTime: string;
  scheduleEnabled?: boolean;
  autoSendCancelled?: boolean;
};

function armed(input: SendWindowInput, now: Date) {
  return isWeeklySendArmed({ applied: true, ...input, now });
}

/**
 * Whether the send window is open right now. Checked every second while it
 * could open, but the component only re-renders when the answer flips.
 */
export function useWeeklySendArmed(input: SendWindowInput | null | undefined): boolean {
  const [isArmed, setArmed] = useState(() => (input ? armed(input, new Date()) : false));
  useEffect(() => {
    if (!input || input.alreadySent) {
      setArmed(false);
      return;
    }
    const check = () => setArmed(armed(input, new Date()));
    check();
    const timer = window.setInterval(check, 1000);
    return () => window.clearInterval(timer);
  }, [input]);
  return isArmed;
}

/** The end of the open send window, or null when it is not open. */
export function sendWindowEnd(input: SendWindowInput, isArmed: boolean): Date | null {
  if (!isArmed) return null;
  return (
    weeklySendWindow({
      now: new Date(),
      sendWeekday: input.sendWeekday,
      sendTime: input.sendTime,
      scheduleEnabled: input.scheduleEnabled,
    })?.end ?? null
  );
}

/** A per-second countdown label until `until`; only the calling component re-renders. */
export function useSendWindowCountdown(until: Date | null | undefined): string | null {
  const [remainingMs, setRemainingMs] = useState<number | null>(() =>
    until ? Math.max(0, until.getTime() - Date.now()) : null,
  );
  useEffect(() => {
    if (!until) {
      setRemainingMs(null);
      return;
    }
    const tick = () => setRemainingMs(Math.max(0, until.getTime() - Date.now()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  return remainingMs === null ? null : formatSendWindowCountdown(remainingMs);
}
