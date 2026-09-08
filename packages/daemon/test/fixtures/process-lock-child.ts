import { acquireProcessLock } from "../../src/platform/process-lock";
import { runMachineSupervisor } from "../../src/supervisor/run-supervisor";

const [mode, path] = Bun.argv.slice(2);
if (!mode || !path) throw new Error("mode and lock path are required");

if (mode === "contend") {
  console.log("ready");
  for await (const _line of console) break;
  try {
    const lock = acquireProcessLock(path);
    console.log("acquired");
    for await (const _line of console) break;
    lock.release();
  } catch {
    console.log("contended");
  }
} else if (mode === "spawn-child") {
  const lock = acquireProcessLock(path);
  const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  console.log(`child:${child.pid}`);
  void lock;
} else if (mode === "fail") {
  const lock = acquireProcessLock(path);
  try {
    throw new Error("startup failed");
  } finally {
    lock.release();
  }
} else if (mode === "supervisor-fail") {
  await runMachineSupervisor(["--socket", `${path}/daemon.sock`, "--state-directory", path]);
}
