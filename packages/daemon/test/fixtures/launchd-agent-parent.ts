import { LaunchdProcessOwner } from "../../src/platform/launchd-process";

const [directory, prefix] = Bun.argv.slice(2);
const owner = new LaunchdProcessOwner({
  directory: directory!,
  prefix: prefix!,
  runner: [process.execPath, `${import.meta.dir}/launchd-agent-runner.ts`],
});
const tree = owner.spawn(["/bin/sh", "-c", "echo $$; sleep 300 & wait"], directory!, {
  PATH: "/usr/bin:/bin",
});
for await (const bytes of tree.child.stdout) Bun.stdout.write(bytes);
await tree.child.exited;
