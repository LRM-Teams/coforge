const child = Bun.spawn({
  cmd: [
    process.execPath,
    "-e",
    `
    const grandchild = Bun.spawn({ cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"] });
    console.log(JSON.stringify({ grandchildPid: grandchild.pid }));
    setInterval(() => {}, 1000);
  `,
  ],
  stdout: "pipe",
});

const reader = child.stdout.getReader();
const { value } = await reader.read();
const line = new TextDecoder().decode(value).split("\n")[0];
const { grandchildPid } = JSON.parse(line!) as { grandchildPid: number };
reader.releaseLock();
console.log(JSON.stringify({ childPid: child.pid, grandchildPid }));

// Reproduce providers that let their direct process exit on EOF while descendants continue.
if (process.env.EXIT_DIRECT === "1") {
  process.exit(17);
} else {
  await new Response(Bun.stdin.stream()).text();
}
