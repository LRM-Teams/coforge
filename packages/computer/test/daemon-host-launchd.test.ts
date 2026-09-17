import { expect, test } from "bun:test";
import {
  decodeDaemonHandshakeRequest,
  decodeLocalRpcRequest,
  encodeDaemonHandshakeResponse,
  encodeLocalRpcResponse,
  LOCAL_RPC_METHODS,
  readLocalRpcFrame,
} from "@lrm/coforge-sdk/internal";
import { LaunchdDaemonHost, launchdPlist } from "@lrm/coforge-daemon";

const target = "gui/501/cn.coforge.computer.daemon";

/** A `connect` fake whose handshake always succeeds, so `restart()`/`ensureRunning()` can
 * complete past their local-socket wait without a real Unix socket. */
function acceptingConnect(serverUrl: string) {
  return async () => ({
    request: async (frame: Uint8Array) => {
      const envelope = decodeLocalRpcRequest(readLocalRpcFrame(frame)!);
      const request = decodeDaemonHandshakeRequest(envelope.payload);
      return encodeLocalRpcResponse({
        method: LOCAL_RPC_METHODS.HANDSHAKE,
        payload: encodeDaemonHandshakeResponse({
          protocolMajor: 1,
          requestId: request.requestId,
          daemonId: "daemon-1",
          accepted: true,
          serverUrl,
        }),
      });
    },
    close() {},
  });
}

test("launchd service dispatches the daemon through the unified executable", () => {
  const plist = launchdPlist({
    label: "cn.coforge.computer.daemon",
    executablePath: "/Users/alice/.coforge/computer/install/active/coforge-computer",
    socketPath: "/Users/alice/.coforge/daemon/daemon.sock",
  });

  expect(plist).toContain("<key>RunAtLoad</key>");
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(plist).toContain(
    "<array><string>/Users/alice/.coforge/computer/install/active/coforge-computer</string><string>__daemon</string><string>--socket</string>",
  );
  expect(plist).not.toContain("alice-secret");
});

test("launchd installation is idempotent and does not restart an installed user agent", async () => {
  const commands: string[][] = [];
  const writes: string[] = [];
  let installed = false;
  const service = new LaunchdDaemonHost({
    serverUrl: "https://coforge.test",
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-daemon",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    writeFile: async (path) => {
      writes.push(path);
    },
    run: async (command) => {
      commands.push(command);
      if (command[1] === "print") return { code: installed ? 0 : 1, stdout: "", stderr: "" };
      if (command[1] === "bootstrap") installed = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  await service.ensureInstalled();
  await service.ensureInstalled();
  expect(writes).toHaveLength(1);
  expect(commands).toEqual([
    ["launchctl", "print", target],
    [
      "launchctl",
      "bootstrap",
      "gui/501",
      "/Users/alice/Library/LaunchAgents/cn.coforge.computer.daemon.plist",
    ],
    ["launchctl", "print", target],
  ]);
});

test("launchd ensureRunning starts only through the user agent before handshaking", async () => {
  const commands: string[][] = [];
  const registrationFailed = new Error("registration failed for test");
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    writeFile: async () => {},
    run: async (command) => {
      commands.push(command);
      if (command[1] === "print") return { code: 1, stdout: "", stderr: "" };
      throw registrationFailed;
    },
  });

  await expect(service.ensureRunning()).rejects.toBe(registrationFailed);
  expect(commands).toEqual([
    ["launchctl", "print", target],
    [
      "launchctl",
      "bootstrap",
      "gui/501",
      "/Users/alice/Library/LaunchAgents/cn.coforge.computer.daemon.plist",
    ],
  ]);
});

test("launchd stop accepts an absent process but preserves permission errors with their diagnostic", async () => {
  let exitCode = 3;
  let stderr = "";
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    run: async () => ({ code: exitCode, stdout: "", stderr }),
  });
  await service.stop();
  exitCode = 13;
  stderr = "Permission denied\n";
  await expect(service.stop()).rejects.toThrow("launchctl bootout failed (13): Permission denied");
});

test("REGRESSION: stop does not return until the label actually leaves launchd after bootout", async () => {
  // Reproduces the dev.34→dev.35 incident: `bootout` returns immediately, but launchd keeps
  // answering `print` with the outgoing instance for a few seconds while it runs its own
  // SIGTERM/SIGKILL teardown ladder. `stop()` must poll a fresh `print` rather than trusting
  // `bootout`'s return.
  const printCalls: number[] = [];
  const disappearsAfter = 3;
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    sleep: async () => {},
    run: async (command) => {
      if (command[1] === "bootout") return { code: 0, stdout: "", stderr: "" };
      if (command[1] === "print") {
        printCalls.push(1);
        return { code: printCalls.length <= disappearsAfter ? 0 : 1, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await service.stop();
  expect(printCalls).toHaveLength(disappearsAfter + 1);
});

test("stop returns immediately when the label is already absent", async () => {
  const commands: string[][] = [];
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    run: async (command) => {
      commands.push(command);
      return { code: 3, stdout: "", stderr: "" };
    },
  });

  await service.stop();
  expect(commands).toEqual([["launchctl", "bootout", target]]);
});

test("stop times out with a clear error when the old job never leaves launchd", async () => {
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    stopTimeoutMilliseconds: 0,
    sleep: async () => {},
    run: async (command) => {
      if (command[1] === "bootout") return { code: 0, stdout: "", stderr: "" };
      if (command[1] === "print") return { code: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await expect(service.stop()).rejects.toThrow("did not leave launchd");
});

test("REGRESSION: restart on a loaded label issues exactly kickstart -k, never bootout or bootstrap", async () => {
  const commands: string[][] = [];
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    serverUrl: "https://coforge.test",
    connect: acceptingConnect("https://coforge.test"),
    run: async (command) => {
      commands.push(command);
      if (command[1] === "print") return { code: 0, stdout: "", stderr: "" };
      if (command[1] === "kickstart") return { code: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await service.restart();
  expect(commands).toEqual([
    ["launchctl", "print", target],
    ["launchctl", "kickstart", "-k", target],
  ]);
});

test("restart bootstraps when the label is absent, retrying only EIO(5)/already-in-progress(37), giving up after 3", async () => {
  const commands: string[][] = [];
  const sleeps: number[] = [];
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    writeFile: async () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    run: async (command) => {
      commands.push(command);
      if (command[1] === "print") return { code: 1, stdout: "", stderr: "" };
      if (command[1] === "bootstrap")
        return { code: 5, stdout: "", stderr: "Input/output error tearing down old service" };
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await expect(service.restart()).rejects.toThrow(
    "launchctl bootstrap failed (5): Input/output error tearing down old service",
  );
  expect(commands.filter((c) => c[1] === "bootstrap")).toHaveLength(3);
  expect(commands.some((c) => c[1] === "bootout" || c[1] === "kickstart")).toBe(false);
  expect(sleeps).toEqual([1_000, 1_000]);
});

test("restart does not retry bootstrap on a non-retryable exit code", async () => {
  const commands: string[][] = [];
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    writeFile: async () => {},
    sleep: async () => {
      throw new Error("must not sleep on a non-retryable failure");
    },
    run: async (command) => {
      commands.push(command);
      if (command[1] === "print") return { code: 1, stdout: "", stderr: "" };
      if (command[1] === "bootstrap") return { code: 71, stdout: "", stderr: "" };
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await expect(service.restart()).rejects.toThrow("launchctl bootstrap failed (71)");
  expect(commands.filter((c) => c[1] === "bootstrap")).toHaveLength(1);
});

test("restart recovers via bootstrap after a retryable failure and completes the handshake", async () => {
  const commands: string[][] = [];
  let bootstrapAttempts = 0;
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    serverUrl: "https://coforge.test",
    connect: acceptingConnect("https://coforge.test"),
    writeFile: async () => {},
    sleep: async () => {},
    run: async (command) => {
      commands.push(command);
      if (command[1] === "print") return { code: 1, stdout: "", stderr: "" };
      if (command[1] === "bootstrap") {
        bootstrapAttempts += 1;
        return bootstrapAttempts === 1
          ? { code: 37, stdout: "", stderr: "operation already in progress" }
          : { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await service.restart();
  expect(commands.filter((c) => c[1] === "bootstrap")).toHaveLength(2);
});

test("assertRestartable throws with the launchctl diagnostic when the label is not loaded", async () => {
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    run: async () => ({
      code: 113,
      stdout: "",
      stderr: 'Could not find service "cn.coforge.computer.daemon" in domain for port\n',
    }),
  });

  await expect(service.assertRestartable()).rejects.toThrow(
    'launchctl print failed (113): Could not find service "cn.coforge.computer.daemon" in domain for port',
  );
});

test("assertRestartable resolves when the label is loaded", async () => {
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
  });

  await expect(service.assertRestartable()).resolves.toBeUndefined();
});

test("a failed launchctl command carries its stderr diagnostic in the thrown error", async () => {
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    run: async (command) => {
      if (command[1] === "print") return { code: 0, stdout: "", stderr: "" };
      if (command[1] === "kickstart")
        return {
          code: 113,
          stdout: "",
          stderr: 'Could not find service "cn.coforge.computer.daemon" in domain for port\n',
        };
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await expect(service.restart()).rejects.toThrow(
    'launchctl kickstart failed (113): Could not find service "cn.coforge.computer.daemon" in domain for port',
  );
});
