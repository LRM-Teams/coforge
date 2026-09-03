import { Cloud, Laptop, Monitor, Server, type LucideIcon } from "lucide-react";

import { m } from "@/paraglide/messages";

/**
 * How the Web names and pictures one Computer.
 *
 * `kind` says where the machine runs and is the distinction that matters
 * first: a cloud Computer is a CoForge-hosted sandbox node, a local one is a
 * machine the User controls. Within a local Computer the platform prefix of
 * `machineId` (`macos:…`, `linux:…`, `win32:…`) is the only other
 * human-readable fact the Web holds, until a Computer carries a name.
 */
export type ComputerKind = "local" | "cloud";
export type ComputerPlatform = "macos" | "linux" | "windows" | "unknown";

export type ComputerIdentity = {
  kind: string;
  machineId: string;
};

export function computerKind(kind: string): ComputerKind {
  return kind === "cloud" ? "cloud" : "local";
}

export function computerPlatform(machineId: string): ComputerPlatform {
  const prefix = machineId.split(":", 1)[0];
  if (prefix === "macos") return "macos";
  if (prefix === "linux") return "linux";
  if (prefix === "win32") return "windows";
  return "unknown";
}

export function computerLabel(computer: ComputerIdentity): string {
  if (computerKind(computer.kind) === "cloud") return m.computer_cloud_computer();
  const platform = computerPlatform(computer.machineId);
  if (platform === "macos") return m.computer_platform_macos();
  if (platform === "linux") return m.computer_platform_linux();
  if (platform === "windows") return m.computer_platform_windows();
  return m.computer_platform_unknown();
}

export function computerIcon(computer: ComputerIdentity): LucideIcon {
  if (computerKind(computer.kind) === "cloud") return Cloud;
  const platform = computerPlatform(computer.machineId);
  if (platform === "macos") return Laptop;
  if (platform === "linux") return Server;
  return Monitor;
}
