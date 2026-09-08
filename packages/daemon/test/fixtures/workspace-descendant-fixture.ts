import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const argv = Bun.argv.slice(2);
const role = argv[0];
const stateDirectory =
  role === "__workspace-daemon" ? argv[argv.indexOf("--state-directory") + 1] : argv[1];
if (!role || !stateDirectory) throw new Error("role and state directory are required");
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });

if (role === "__workspace-daemon") {
  // This fixture is compiled: dispatch the executable's own role, not Bun's
  // source-file or -e interface.
  const child = Bun.spawn([process.execPath, "agent", stateDirectory], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  await writeFile(join(stateDirectory, "agent.pid"), String(child.pid));
  while (!(await Bun.file(join(stateDirectory, "agent.ready")).exists())) {
    if (child.exitCode !== null) throw new Error("Agent fixture exited before readiness");
    await Bun.sleep(10);
  }
  // Deliberately precedes Workspace readiness, not a Coordinator persistence gate.
  await writeFile(join(stateDirectory, "pre-ready"), String(process.pid));
  while (!(await Bun.file(join(stateDirectory, "crash")).exists())) await Bun.sleep(10);
  process.kill(process.pid, "SIGKILL");
} else if (role === "agent") {
  await writeFile(join(stateDirectory, "agent.ready"), String(process.pid));
  await Bun.sleep(60 * 60 * 1000);
} else {
  throw new Error(`unknown fixture role: ${role}`);
}
