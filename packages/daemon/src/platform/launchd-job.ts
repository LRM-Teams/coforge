import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";

import type { NativeProcessIdentity } from "../supervisor/workspace-instance";

export type NativeCommandResult = { code: number; stdout: string; stderr: string };

/**
 * Native launchd access. Injectable so job lifecycle is testable without
 * creating, signalling, or removing real user jobs.
 */
export type LaunchdJobPlatform = {
  jobs(): Promise<Map<string, number>>;
  run(args: string[]): Promise<NativeCommandResult>;
};

export type LaunchdJobConfig = {
  label: string;
  directory: string;
  command: string[];
  environment?: Record<string, string>;
  restartOnFailure?: boolean;
  platform?: LaunchdJobPlatform;
};

/** Native user-job lifecycle. `list` has documented columns; `print` is not an API. */
export class LaunchdJob {
  readonly path: string;
  readonly target: string;
  readonly #platform: LaunchdJobPlatform;
  constructor(readonly config: LaunchdJobConfig) {
    if (!/^cn\.coforge\.[A-Za-z0-9.-]+$/.test(config.label)) throw new Error("invalid job label");
    this.path = join(config.directory, `${config.label}.plist`);
    this.target = `gui/${process.getuid!()}/${config.label}`;
    this.#platform = config.platform ?? nativeLaunchd;
  }

  async ensureStarted(): Promise<NativeProcessIdentity> {
    const existing = await this.identity();
    if (existing?.active) return existing;
    if (!(await this.#platform.jobs()).has(this.config.label)) {
      await mkdir(this.config.directory, { recursive: true, mode: 0o700 });
      await writeFile(this.path, jobPlist(this.config), { mode: 0o600 });
      await this.#launchctl(["bootstrap", `gui/${process.getuid!()}`, this.path]);
    } else {
      await this.#launchctl(["kickstart", this.target]);
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const identity = await this.identity();
      if (identity?.active) return identity;
      await Bun.sleep(25);
    }
    throw new Error("launchd job did not start");
  }

  async identity(): Promise<NativeProcessIdentity | null> {
    const pid = (await this.#platform.jobs()).get(this.config.label);
    if (!pid) return null;
    const observed = await capture([
      "/bin/ps",
      "-p",
      String(pid),
      "-o",
      "lstart=",
      "-o",
      "pgid=",
      "-o",
      "stat=",
    ]);
    if (observed.code === 1 && !observed.stdout.trim()) return null;
    const match = observed.stdout.trim().match(/^(.{24})\s+(\d+)\s+(\S+)$/);
    if (observed.code || !match) throw new Error("invalid launchd process identity");
    // launchd can publish the PID before its child has established its process
    // group. This is not a ready identity and must never be adopted or signalled.
    if (Number(match[2]) !== pid) return null;
    if (match[3]!.startsWith("Z")) return null;
    if ((await this.#platform.jobs()).get(this.config.label) !== pid) return null;
    return { mainPid: pid, active: true, invocationId: `${pid}:${match[1]}` };
  }

  async stop(): Promise<void> {
    const jobs = await this.#platform.jobs();
    const pid = jobs.get(this.config.label);
    if (jobs.has(this.config.label)) {
      try {
        await this.#launchctl(["bootout", this.target]);
      } catch (error) {
        // The Workspace and Coordinator may both finish cleanup. A failed
        // bootout is successful only when a fresh OS query proves removal;
        // the process-group observation below must still complete.
        if ((await this.#platform.jobs()).has(this.config.label)) throw error;
      }
    }
    const deadline = Date.now() + 10_000;
    while (
      (await this.#platform.jobs()).has(this.config.label) ||
      (pid && (await processGroupExists(pid)))
    ) {
      if (Date.now() >= deadline) throw new Error("launchd job cleanup did not complete");
      await Bun.sleep(25);
    }
    await rm(this.path, { force: true });
  }

  async signal(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void> {
    if ((await this.#platform.jobs()).has(this.config.label))
      await this.#launchctl(["kill", signal, this.target]);
  }

  async #launchctl(args: string[]): Promise<void> {
    const result = await this.#platform.run(args);
    if (!result.code) return;
    const diagnostic = nativeCommandDiagnostic(result.stderr);
    getLogger(["coforge", "daemon", "launchd"]).error("Native job command failed", {
      event: "launchd:command_failed",
      operation: args[0],
      exit_code: result.code,
      ...(diagnostic ? { error_message: diagnostic } : {}),
    });
    throw new Error(
      diagnostic
        ? `launchctl ${args[0]} failed (${result.code}): ${diagnostic}`
        : `launchctl ${args[0]} failed (${result.code})`,
    );
  }
}

export async function launchdJobs(): Promise<Map<string, number>> {
  const result = await capture(["/bin/launchctl", "list"]);
  if (result.code) throw new Error("launchd user manager is unavailable");
  const jobs = new Map<string, number>();
  for (const line of result.stdout.trim().split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || !/^(\d+|-)$/.test(fields[0]!) || !/^-?\d+$/.test(fields[1]!))
      throw new Error("invalid launchd job list");
    jobs.set(fields[2]!, fields[0] === "-" ? 0 : Number(fields[0]));
  }
  return jobs;
}

export async function stopLaunchdJobs(prefix: string, directory: string): Promise<void> {
  if (!/^cn\.coforge\.agent\.[a-f0-9]{24}\.$/.test(prefix))
    throw new Error("invalid Agent job scope");
  for (const label of (await launchdJobs()).keys()) {
    if (label.startsWith(prefix)) await new LaunchdJob({ label, directory, command: [] }).stop();
  }
}

export async function processGroupExists(pid: number): Promise<boolean> {
  const result = await capture(["/bin/ps", "-axo", "pgid=,stat="]);
  if (result.code) throw new Error("could not observe process groups");
  return result.stdout.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pid && !!state && !state.startsWith("Z");
  });
}

async function capture(command: string[]) {
  const child = Bun.spawn(command, {
    env: { LC_ALL: "C" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/**
 * launchctl explains a failure only on stderr. Keeping that text is the
 * difference between an actionable log record and a bare exit code, so a
 * failed native command must never discard it.
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

async function launchctlCommand(args: string[]): Promise<NativeCommandResult> {
  return await capture(["/bin/launchctl", ...args]);
}

const nativeLaunchd: LaunchdJobPlatform = {
  jobs: launchdJobs,
  run: launchctlCommand,
};

function xml(value: string): string {
  // XML 1.0 disallows these control characters, including NUL.
  // oxlint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error("invalid plist value");
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function jobPlist(config: LaunchdJobConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(config.label)}</string>
<key>ProgramArguments</key><array>${config.command.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(config.environment ?? {})
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("")}</dict>
<key>RunAtLoad</key><true/>
${config.restartOnFailure ? "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>" : ""}
<key>AbandonProcessGroup</key><false/>
<key>ExitTimeOut</key><integer>2</integer>
</dict></plist>\n`;
}
