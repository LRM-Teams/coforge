import { Cloud, Monitor, type LucideIcon } from "lucide-react";

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

export function computerIcon(computer: ComputerIdentity): LucideIcon {
  if (computerKind(computer.kind) === "cloud") return Cloud;
  return Monitor;
}
