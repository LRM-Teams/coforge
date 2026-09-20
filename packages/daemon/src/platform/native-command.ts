/** One finished run of a platform service-manager command (`launchctl`, `systemctl`). */
export type NativeCommandResult = { code: number; stdout: string; stderr: string };

/**
 * The part of a service manager's own stderr worth repeating to a person: a service manager
 * explains a refusal far better than CoForge can guess at it, but it is free to write a wall of
 * text, so this keeps the leading lines and bounds the length.
 */
export function nativeCommandDiagnostic(stderr: string): string {
  return stderr
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" ")
    .slice(0, 500);
}
