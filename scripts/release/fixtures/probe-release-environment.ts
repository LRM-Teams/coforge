import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// This worker owns all handles to the compiled executable. Its OS exit releases
// them before the parent test removes the executable, without relying on GC.
async function probe(executable: string, directory: string, serverUrl: string) {
  const version = Bun.spawnSync([executable, "--cli-version"], {
    env: { ...Bun.env, COFORGE_COMPUTER_VERSION: "0.0.0-wrong" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const otherServer = serverUrl.includes("staging")
    ? "https://coforge.cn"
    : "https://staging.coforge.cn";
  const state = join(directory, "daemon-state");
  await mkdir(state);
  await Bun.write(
    join(state, "config.json"),
    JSON.stringify({
      computerId: "test-computer",
      workspaceId: "test-workspace",
      workspaceRoot: directory,
      serverHttpUrl: otherServer,
    }),
  );
  const daemon = Bun.spawn(
    [
      executable,
      "__workspace-daemon",
      "--socket",
      join(directory, "daemon.sock"),
      "--state-directory",
      state,
    ],
    {
      env: {
        ...Bun.env,
        HOME: join(directory, "daemon-home"),
        COFORGE_DAEMON_SERVER_URL: otherServer,
        COFORGE_SERVER_HTTP_URL: otherServer,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    },
  );
  // Process exit does not imply EOF on every pipe. Drain both before
  // removing the executable and its state directory, especially on Windows.
  const [daemonCode, daemonOutput, daemonError] = await Promise.all([
    daemon.exited,
    new Response(daemon.stdout).text(),
    new Response(daemon.stderr).text(),
  ]);

  const requests: string[] = [];
  const proxy = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        requests.push(data.toString());
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      },
    },
  });
  try {
    const login = Bun.spawn([executable, "login"], {
      env: {
        ...Bun.env,
        HOME: join(directory, "clean-home"),
        COFORGE_RELEASE_FEED_URL: "https://invalid.example",
        COFORGE_SERVER_HTTP_URL: "https://invalid.example",
        HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
        https_proxy: `http://127.0.0.1:${proxy.port}`,
        NO_PROXY: "",
        no_proxy: "",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    const [code, stdout, stderr] = await Promise.all([
      login.exited,
      new Response(login.stdout).text(),
      new Response(login.stderr).text(),
    ]);
    return {
      version: {
        exitCode: version.exitCode,
        stdout: version.stdout.toString(),
        stderr: version.stderr.toString(),
      },
      processes: {
        version: { pid: version.pid, exitCode: version.exitCode },
        daemon: { pid: daemon.pid, exitCode: daemonCode, pipesDrained: true },
        login: { pid: login.pid, exitCode: code, pipesDrained: true },
      },
      daemonCode,
      daemonOutput,
      daemonError,
      code,
      stdout,
      stderr,
      requests,
    };
  } finally {
    proxy.stop(true);
  }
}

const [executable, directory, serverUrl] = Bun.argv.slice(2);
if (!executable || !directory || !serverUrl) throw new Error("Missing release probe arguments");
console.log(JSON.stringify(await probe(executable, directory, serverUrl)));
