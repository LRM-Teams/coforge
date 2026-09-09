import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { LaunchdJob, processGroupExists } from "./launchd-job";
import { ProcessChannel } from "./process-channel";
import type { OwnedProcessTree, ProcessTreeSpawner } from "./process-tree";

/** Provider-neutral stdio over a private socket to an OS-owned job. */
export class LaunchdProcessOwner implements ProcessTreeSpawner {
  constructor(private readonly options: { directory: string; prefix: string; runner: string[] }) {}

  spawn(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
  ): OwnedProcessTree {
    const executable = command[0] && Bun.which(command[0], { cwd, PATH: environment.PATH ?? "" });
    if (!executable) throw new Error("Executable not found");
    const root = mkdtempSync("/private/tmp/cf-agent-");
    chmodSync(root, 0o700);
    const socketPath = join(root, "stdio.sock");
    const job = new LaunchdJob({
      directory: this.options.directory,
      label: `${this.options.prefix}${crypto.randomUUID()}`,
      command: [...this.options.runner, socketPath],
    });
    let processId: number | undefined;
    let jobPid: number | undefined;
    let exitCode: number | null = null;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let stdout!: ReadableStreamDefaultController<Uint8Array>;
    let stderr!: ReadableStreamDefaultController<Uint8Array>;
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        stdout = controller;
      },
    });
    const errors = new ReadableStream<Uint8Array>({
      start(controller) {
        stderr = controller;
      },
    });
    let closed = false;
    let connected = false;
    let cleanup: Promise<void> | undefined;
    const finish = (code: number) => {
      if (closed) return;
      closed = true;
      exitCode = code;
      stdout.close();
      stderr.close();
      resolveExit(code);
    };
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    void ready.catch(() => {});
    const channel = new ProcessChannel((record) => {
      if (record.type === "hello" && Number.isSafeInteger(record.pid)) {
        void started
          .then((identity) => {
            if (identity.mainPid !== record.pid) throw new Error("Agent job identity mismatch");
            channel.send({
              type: "start",
              command: [executable, ...command.slice(1)],
              cwd,
              environment,
            });
          })
          .catch(fail);
      } else if (record.type === "started" && Number.isSafeInteger(record.pid)) {
        processId = Number(record.pid);
        readyResolve();
      } else if (
        (record.type === "stdout" || record.type === "stderr") &&
        typeof record.data === "string"
      ) {
        if (!closed)
          (record.type === "stdout" ? stdout : stderr).enqueue(Buffer.from(record.data, "base64"));
      } else if (record.type === "exit" && Number.isInteger(record.code)) {
        finish(Number(record.code));
      } else throw new Error("invalid Agent job response");
    });
    const fail = (_error: unknown) => {
      readyReject(new Error("native Agent job failed"));
      finish(1);
      void stop().catch(() => {});
    };
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          if (connected) {
            socket.terminate();
            return;
          }
          connected = true;
          channel.attach(socket);
        },
        data(_socket, bytes) {
          try {
            channel.read(bytes);
          } catch (error) {
            fail(error);
          }
        },
        drain() {
          try {
            channel.drain();
          } catch (error) {
            fail(error);
          }
        },
        close() {
          fail(new Error("Agent job disconnected"));
        },
        error(_socket, error) {
          fail(error);
        },
      },
    });
    chmodSync(socketPath, 0o600);
    const started = job.ensureStarted().then((identity) => {
      jobPid = identity.mainPid;
      return identity;
    });
    void started.catch(fail);
    const startupTimeout = setTimeout(() => fail(new Error("Agent job startup timeout")), 10_000);
    void ready.then(
      () => clearTimeout(startupTimeout),
      () => clearTimeout(startupTimeout),
    );
    function stop(): Promise<void> {
      return (cleanup ??= (async () => {
        await started.catch(() => {});
        await job.stop();
        channel.close();
        server.stop(true);
        finish(exitCode ?? 1);
        readyReject(new Error("Agent job stopped"));
        await rm(root, { recursive: true, force: true });
      })());
    }
    let writes = Promise.resolve();
    const send = (record: Record<string, unknown>) => {
      writes = writes.then(async () => {
        await ready;
        channel.send(record);
        await channel.flush();
      });
      void writes.catch(fail);
    };
    return {
      child: {
        get pid() {
          return processId;
        },
        get exitCode() {
          return exitCode;
        },
        exited,
        stdout: output,
        stderr: errors,
        stdin: {
          write(value) {
            send({ type: "stdin", data: value });
            return true;
          },
          end() {
            if (!closed) send({ type: "end" });
          },
          flush: () => writes,
        },
        kill(signal = "SIGTERM") {
          if (!closed) send({ type: "signal", signal });
        },
      },
      terminate: async (_force) => {
        await stop();
      },
      waitForExit: async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (!closed || (jobPid && (await processGroupExists(jobPid)))) {
          if (Date.now() >= deadline) return false;
          await Bun.sleep(20);
        }
        return true;
      },
    };
  }
}

/** Internal executable mode. No arguments or credentials are persisted in the plist. */
export async function runLaunchdAgent(socketPath: string): Promise<void> {
  if (!/^\/private\/tmp\/cf-agent-[A-Za-z0-9]+\/stdio\.sock$/.test(socketPath ?? ""))
    throw new Error("invalid Agent relay socket");
  let child: Subprocess<"pipe", "pipe", "pipe"> | undefined;
  process.on("SIGTERM", () => {
    if (child) child.kill("SIGTERM");
    else process.exit(0);
  });
  let input = Promise.resolve();
  const channel = new ProcessChannel((record) => {
    if (record.type === "start") {
      if (
        child ||
        !Array.isArray(record.command) ||
        !record.command.length ||
        !record.command.every((arg) => typeof arg === "string") ||
        typeof record.cwd !== "string" ||
        !record.environment ||
        typeof record.environment !== "object" ||
        Array.isArray(record.environment) ||
        !Object.values(record.environment).every((value) => typeof value === "string")
      )
        throw new Error("invalid Agent start");
      child = Bun.spawn({
        cmd: record.command,
        cwd: record.cwd,
        env: record.environment as Record<string, string>,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
      });
      channel.send({ type: "started", pid: child.pid });
      const relay = async (stream: ReadableStream<Uint8Array>, type: string) => {
        for await (const data of stream) {
          channel.send({ type, data: Buffer.from(data).toString("base64") });
          await channel.flush();
        }
      };
      const drained = Promise.all([relay(child.stdout, "stdout"), relay(child.stderr, "stderr")]);
      void drained.catch(() => process.exit(1));
      void child.exited
        .then(async (code) => {
          // A descendant can retain stdio after its parent exits; never wait forever.
          await Promise.race([drained, Bun.sleep(1000)]);
          channel.send({ type: "exit", code });
          await channel.flush();
          process.exit(code);
        })
        .catch(() => process.exit(1));
    } else if (record.type === "stdin" && child && typeof record.data === "string") {
      const target = child;
      input = input.then(async () => {
        target.stdin.write(record.data as string);
        await target.stdin.flush();
      });
      void input.catch(() => process.exit(1));
    } else if (record.type === "end" && child) {
      const target = child;
      void input.then(() => target.stdin.end());
    } else if (
      record.type === "signal" &&
      child &&
      ["SIGINT", "SIGTERM", "SIGKILL"].includes(String(record.signal))
    ) {
      child.kill(record.signal as "SIGINT" | "SIGTERM" | "SIGKILL");
    } else throw new Error("invalid Agent relay request");
  });
  await Bun.connect({
    unix: socketPath,
    socket: {
      open(socket) {
        channel.attach(socket);
        channel.send({ type: "hello", pid: process.pid });
      },
      data(_socket, data) {
        try {
          channel.read(data);
        } catch {
          process.exit(1);
        }
      },
      drain() {
        try {
          channel.drain();
        } catch {
          process.exit(1);
        }
      },
      close() {
        process.exit(1);
      },
      error() {
        process.exit(1);
      },
    },
  });
}
