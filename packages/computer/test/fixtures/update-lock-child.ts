import { ComputerUpdater } from "../../src/updater";

const updater = new ComputerUpdater({
  installRoot: Bun.argv[2]!,
  target: "linux-x64",
  baseUrl: "https://releases.example/",
});

await updater.withExclusiveOperation(async () => {
  console.log("acquired");
  for await (const line of console) {
    if (line.trim() === "release") break;
  }
});
