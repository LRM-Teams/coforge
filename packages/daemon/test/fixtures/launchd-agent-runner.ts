import { runLaunchdAgent } from "../../src/platform/launchd-process";
await runLaunchdAgent(Bun.argv.at(-1)!);
