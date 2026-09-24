import { agentEnvironment } from "./environment";

export type CatalogCommandResult = Readonly<{
  output: string;
  exitCode: number;
}>;

/**
 * Runs one provider catalog command and owns its child-process lifecycle.
 *
 * Providers decide what the result means: some require a zero exit code while others can use
 * output from a command that exits non-zero. This module only supplies the common environment,
 * bounded stdout/exit wait, and cleanup contract.
 */
export async function runCatalogCommand(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<CatalogCommandResult> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd,
    env: {
      ...agentEnvironment(undefined, environment),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });

  try {
    return await Promise.race([
      Promise.all([new Response(child.stdout).text(), child.exited]).then(([output, exitCode]) => ({
        output,
        exitCode,
      })),
      Bun.sleep(timeoutMs).then(() => {
        throw new Error(`catalog command timed out after ${timeoutMs} ms`);
      }),
    ]);
  } finally {
    child.kill();
  }
}
