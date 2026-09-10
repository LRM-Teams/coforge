import { Cloud01 as Cloud, Monitor01 as Monitor } from "@untitledui/icons";

import { m } from "@/paraglide/messages";

/**
 * How the Web names and pictures one Computer.
 *
 * `displayName` is the human-facing identity and `name` is its system hostname.
 * `kind` says whether it runs locally or in CoForge's
 * cloud; machine identity never participates in display or selection.
 */
export type ComputerKind = "local" | "cloud";

export type ComputerIdentity = {
  kind: string;
  name: string;
  displayName: string;
};

export function computerKind(kind: string): ComputerKind {
  return kind === "cloud" ? "cloud" : "local";
}

export function computerLabel(computer: ComputerIdentity): string {
  return (
    computer.displayName.trim() ||
    computer.name.trim() ||
    (computerKind(computer.kind) === "cloud"
      ? m.computer_cloud_computer()
      : m.computer_platform_unknown())
  );
}

export function computerIcon(computer: ComputerIdentity): typeof Cloud | typeof Monitor {
  if (computerKind(computer.kind) === "cloud") return Cloud;
  return Monitor;
}

/** What the Computer's daemon last reported about its host machine. */
export type ComputerPlatformInfo = {
  platform?: string | null;
  osVersion?: string | null;
};

export function operatingSystemLabel(computer: ComputerPlatformInfo): string {
  const name =
    computer.platform === "darwin"
      ? "macOS"
      : computer.platform === "linux"
        ? "Linux"
        : computer.platform === "win32"
          ? "Windows"
          : undefined;
  return name
    ? `${name} ${computer.osVersion || m.computer_metadata_unknown()}`
    : m.computer_metadata_unknown();
}
