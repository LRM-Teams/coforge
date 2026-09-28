import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { nativeCommandDiagnostic, type NativeCommandResult } from "#src/platform/native-command";
import { escapeXmlText } from "#src/platform/xml-escape";
import { LocalDaemonLauncher } from "./launcher";
import type { DaemonLauncher, DaemonWorkspaceConfig, LocalDaemonConnection } from "./launcher";

type CommandRunner = (command: string[]) => Promise<NativeCommandResult>;

/** launchd exit codes documented as "a previous bootout for this label is still tearing down":
 * EIO, and "operation already in progress". `restart()`'s bootstrap-when-absent fallback retries
 * only these; every other code is a real failure and must not be retried. */
const BOOTSTRAP_RETRYABLE_EXIT_CODES = new Set([5, 37]);

export type LaunchdDaemonHostOptions = {
  label: string;
  executablePath: string;
  socketPath: string;
  stateDirectory?: string;
  serverUrl?: string;
  daemonConnectionEndpoint?: string;
  homeDirectory: string;
  uid: number;
  writeFile?: (path: string, content: string) => Promise<void>;
  run?: CommandRunner;
  /** Test seam so `stop()`'s post-bootout departure poll and `restart()`'s bootstrap retry
   * backoff do not really wait. Production always uses `Bun.sleep`. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** How long `stop()` waits for the label to actually leave launchd after a successful
   * `bootout` before giving up. Must exceed launchd's ~5 s SIGKILL teardown window; overridable
   * only so tests can force the timeout branch without really waiting. */
  stopTimeoutMilliseconds?: number;
  /** Test seam for the internal Unix-socket handshake that `ensureRunning()`/`restart()` wait on
   * after installing or kickstarting the user agent. Production always dials the real socket. */
  connect?: (socketPath: string) => Promise<LocalDaemonConnection>;
  /** How long the post-kickstart/bootstrap local handshake wait is willing to retry. Forwarded to
   * the internal `LocalDaemonLauncher`; overridable only for tests. */
  handshakeTimeoutMilliseconds?: number;
};

/**
 * The launchd user-agent lifecycle that hosts the CoForge Daemon on macOS. Two capabilities: the
 * ordinary install/start path shared with every platform (`ensureInstalled`, `ensureRunning`,
 * `stop`), and the in-place restart path unique to launchd (`restart`, `assertRestartable`) that
 * an upgrade uses instead of stop-then-start.
 */
export class LaunchdDaemonHost implements DaemonLauncher {
  /** Tells an upgrade lifecycle to restart through `restart()` rather than `stop()` + `start()`.
   * Read this capability instead of branching on `instanceof`/`process.platform`. */
  readonly restartsInPlace = true;
  readonly #plistPath: string;
  readonly #target: string;
  readonly #run: CommandRunner;
  readonly #writeFile: (path: string, content: string) => Promise<void>;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #stopTimeoutMilliseconds: number;
  readonly #options: LaunchdDaemonHostOptions;
  readonly #local: LocalDaemonLauncher;

  constructor(options: LaunchdDaemonHostOptions) {
    this.#options = options;
    this.#plistPath = join(
      options.homeDirectory,
      "Library",
      "LaunchAgents",
      `${options.label}.plist`,
    );
    this.#target = `gui/${options.uid}/${options.label}`;
    this.#run = options.run ?? runCommand;
    this.#writeFile =
      options.writeFile ??
      (async (path, content) => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
      });
    this.#sleep = options.sleep ?? Bun.sleep;
    this.#stopTimeoutMilliseconds = options.stopTimeoutMilliseconds ?? 15_000;
    this.#local = new LocalDaemonLauncher({
      executablePath: options.executablePath,
      socketPath: options.socketPath,
      stateDirectory: options.stateDirectory ?? join(options.homeDirectory, ".coforge", "daemon"),
      serverUrl: options.serverUrl,
      connect: options.connect,
      sleep: options.sleep,
      timeoutMilliseconds: options.handshakeTimeoutMilliseconds,
    });
  }

  preflight(): Promise<void> {
    return this.#local.preflight();
  }

  async ensureStarted(config: DaemonWorkspaceConfig): Promise<void> {
    await this.ensureRunning();
    await this.#local.ensureStarted(config);
  }

  async ensureRunning(): Promise<void> {
    await this.ensureInstalled();
    await this.#local.ensureRunning();
  }

  command(
    operation: "start" | "stop" | "restart",
    workspaceId?: string,
  ): Promise<ManagedRuntimeIdentity[]> {
    return this.#local.command(operation, workspaceId);
  }

  /** Boots the user agent out and waits for it to actually leave launchd. `bootout` returns as
   * soon as it has *asked* launchd to tear the job down, not once launchd has finished doing so —
   * launchd keeps answering `print` with the outgoing instance for a few seconds while it runs
   * its own SIGTERM (grace) / SIGKILL (at 5 s) ladder. The dev.34→dev.35 upgrade incident this
   * fixes bootstrapped a replacement job during exactly that window, found the label still
   * "loaded" from the old instance's point of view, and skipped it — launchd then finished
   * removing the job with nothing left to start the new daemon. A caller must not
   * treat `bootout` returning as the job being gone; only a fresh `print` proves that. */
  async stop(): Promise<void> {
    // Darwin ESRCH (3) means the process is already absent, not a stop failure.
    const bootout = await this.#run(["launchctl", "bootout", this.#target]);
    if (bootout.code === 3) return;
    if (bootout.code !== 0) throw launchctlFailure("bootout", bootout);
    const deadline = Date.now() + this.#stopTimeoutMilliseconds;
    do {
      if ((await this.#run(["launchctl", "print", this.#target])).code !== 0) return;
      await this.#sleep(50);
    } while (Date.now() < deadline);
    throw new Error(
      `CoForge Daemon (${this.#target}) did not leave launchd within ${this.#stopTimeoutMilliseconds}ms of bootout`,
    );
  }

  async ensureInstalled(): Promise<void> {
    if ((await this.#run(["launchctl", "print", this.#target])).code === 0) return;
    await this.#writeFile(this.#plistPath, launchdPlist(this.#options));
    const result = await this.#run([
      "launchctl",
      "bootstrap",
      `gui/${this.#options.uid}`,
      this.#plistPath,
    ]);
    if (result.code !== 0)
      throw new Error(
        "The launchd user agent could not start CoForge Daemon. Run `coforge-computer foreground` under an external supervisor; CoForge will not detach a fallback process.",
        { cause: launchctlFailure("bootstrap", result) },
      );
  }

  /** Throws unless the label is currently loaded in `gui/<uid>`. Lets an upgrade lifecycle refuse
   * a `foreground`, externally supervised Computer — which never installed this user agent —
   * before it switches the active executable symlink, rather than discovering it only after
   * `restart()` finds nothing to kickstart. */
  async assertRestartable(): Promise<void> {
    const result = await this.#run(["launchctl", "print", this.#target]);
    if (result.code !== 0) throw launchctlFailure("print", result);
  }

  /**
   * The in-place replacement an upgrade uses instead of `stop()` + `start()`. When the
   * label is loaded, `launchctl kickstart -k` re-resolves `ProgramArguments` — so a symlink flip
   * that already landed is honoured — and is synchronous: it does not return until the *new*
   * process has been spawned, so there is never an unload window for launchd to remove the job
   * in, unlike `bootout` then `bootstrap`.
   *
   * When the label is not loaded — the recovery branch, not the common case — this falls back to
   * the same write-plist-then-bootstrap `ensureInstalled` uses, retrying only on the documented
   * "a previous bootout is still tearing down" exit codes (5 = EIO, 37 = operation already in
   * progress); any other code fails immediately.
   */
  async restart(): Promise<void> {
    const loaded = (await this.#run(["launchctl", "print", this.#target])).code === 0;
    if (loaded) {
      const result = await this.#run(["launchctl", "kickstart", "-k", this.#target]);
      if (result.code !== 0) throw launchctlFailure("kickstart", result);
    } else {
      await this.#writeFile(this.#plistPath, launchdPlist(this.#options));
      const attempts = 3;
      let failure: NativeCommandResult | undefined;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const result = await this.#run([
          "launchctl",
          "bootstrap",
          `gui/${this.#options.uid}`,
          this.#plistPath,
        ]);
        if (result.code === 0) {
          failure = undefined;
          break;
        }
        failure = result;
        if (!BOOTSTRAP_RETRYABLE_EXIT_CODES.has(result.code) || attempt === attempts) break;
        await this.#sleep(1_000);
      }
      if (failure) throw launchctlFailure("bootstrap", failure);
    }
    await this.#local.ensureRunning();
  }
}

function launchctlFailure(operation: string, result: NativeCommandResult): Error {
  const diagnostic = nativeCommandDiagnostic(result.stderr);
  return new Error(
    diagnostic
      ? `launchctl ${operation} failed (${result.code}): ${diagnostic}`
      : `launchctl ${operation} failed (${result.code})`,
  );
}

export function launchdPlist(input: {
  label: string;
  executablePath: string;
  socketPath: string;
  stateDirectory?: string;
  daemonConnectionEndpoint?: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXmlText(input.label)}</string>
  ${input.daemonConnectionEndpoint ? `<key>EnvironmentVariables</key><dict><key>COFORGE_DAEMON_CONNECTION_ENDPOINT</key><string>${escapeXmlText(input.daemonConnectionEndpoint)}</string></dict>` : ""}
  <key>ProgramArguments</key>
  <array><string>${escapeXmlText(input.executablePath)}</string><string>__daemon</string><string>--socket</string><string>${escapeXmlText(input.socketPath)}</string>${input.stateDirectory ? `<string>--state-directory</string><string>${escapeXmlText(input.stateDirectory)}</string>` : ""}</array>
  ${input.stateDirectory ? `<key>StandardOutPath</key><string>${escapeXmlText(join(input.stateDirectory, "daemon.log"))}</string>\n  <key>StandardErrorPath</key><string>${escapeXmlText(join(input.stateDirectory, "daemon.log"))}</string>` : ""}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

async function runCommand(command: string[]): Promise<NativeCommandResult> {
  const process = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    // Generous: a `kickstart -k` against a job that respawned inside launchd's throttle window
    // can legitimately block for several seconds (measured up to ~9 s), and this must not be
    // mistaken for a hung command.
    timeout: 30_000,
  });
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  return { code, stdout: "", stderr };
}
