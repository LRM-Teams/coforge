import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SupportedPlatform } from "./platform";

export type MachineIdOptions = {
  platform: SupportedPlatform;
  readFile?: () => Promise<string>;
  run?: () => Promise<string>;
  fallback: {
    load(): Promise<string | null>;
    save(value: string): Promise<void>;
  };
};

export class FileMachineIdFallback {
  constructor(private readonly path: string) {}

  async load(): Promise<string | null> {
    try {
      const value = (await readFile(this.path, "utf8")).trim();
      return value || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(value: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export async function resolveMachineId(options: MachineIdOptions): Promise<string> {
  const platformId = await readPlatformId(options);
  if (platformId)
    return `${options.platform === "darwin" ? "macos" : options.platform}:${platformId}`;

  const existing = await options.fallback.load();
  if (existing) return existing;
  const generated = `fallback:${crypto.randomUUID()}`;
  await options.fallback.save(generated);
  return generated;
}

async function readPlatformId(options: MachineIdOptions): Promise<string | null> {
  try {
    if (options.platform === "linux") {
      const value = await (options.readFile ?? (() => Bun.file("/etc/machine-id").text()))();
      return value.trim() || null;
    }
    const output = await (options.run ?? (() => runPlatformCommand(options.platform)))();
    if (options.platform === "darwin") {
      return (
        output
          .match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1]
          ?.trim()
          .toLowerCase() ?? null
      );
    }
    return (
      output
        .match(/MachineGuid\s+REG_SZ\s+([^\s]+)/i)?.[1]
        ?.trim()
        .toLowerCase() ?? null
    );
  } catch {
    return null;
  }
}

async function runPlatformCommand(platform: SupportedPlatform): Promise<string> {
  const command =
    platform === "darwin"
      ? ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]
      : ["reg.exe", "query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"];
  const result = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) throw new Error("machine id command failed");
  return result.stdout.toString();
}
