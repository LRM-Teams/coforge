import { runMachineSupervisor } from "../../src/supervisor/run-supervisor";
await runMachineSupervisor(Bun.argv.slice(2));
