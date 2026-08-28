import { RUNTIME_PROVIDER, type ComputerRegisterRequest } from "@coforge/protocol";

export interface ExternalRuntimeProbe {
  which(name: string): string | undefined;
  spawn(executable: string): {
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
}

const bunExternalRuntimeProbe: ExternalRuntimeProbe = {
  which: (name) => Bun.which(name) ?? undefined,
  spawn: (executable) =>
    Bun.spawn({
      cmd: [executable, "--version"],
      stdout: "pipe",
      stderr: "ignore",
    }),
};

const externalRuntimeExecutables = [
  { provider: RUNTIME_PROVIDER.CODEX, executable: "codex" },
  { provider: RUNTIME_PROVIDER.CLAUDE_CODE, executable: "claude" },
  { provider: RUNTIME_PROVIDER.PI, executable: "pi" },
] as const;

/**
 * Inventories only user-installed external runtimes found on PATH.
 * Built-in Pi is supplied by Daemon/release metadata, not this inventory.
 */
export async function discoverExternalRuntimes(
  probe: ExternalRuntimeProbe = bunExternalRuntimeProbe,
): Promise<ComputerRegisterRequest["runtimes"]> {
  const runtimes: ComputerRegisterRequest["runtimes"] = [];
  for (const { provider, executable: executableName } of externalRuntimeExecutables) {
    const executable = probe.which(executableName);
    if (!executable) continue;
    try {
      const process = probe.spawn(executable);
      const output = await new Response(process.stdout).text();
      if ((await process.exited) !== 0) continue;
      const version = output.trim().split(/\s+/).pop();
      if (version) runtimes.push({ provider, version, kind: "external" });
    } catch {
      // A runtime without a usable version is not inventory metadata.
    }
  }
  return runtimes;
}
