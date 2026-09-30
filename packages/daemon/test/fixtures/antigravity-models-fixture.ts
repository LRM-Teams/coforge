/**
 * Stand-in for `agy models`: a fresh process per invocation, argv-driven, no stdin. The default
 * output is the real 1.2.13 capture in `antigravity-models.txt`; `COFORGE_ANTIGRAVITY_MODELS_*`
 * env vars replace it, fail the command, or (with `hang-models`) keep the process alive so the
 * catalog reader's own timeout is what ends it.
 */
const argv = process.argv.slice(2);

if (argv[0] === "hang-models") {
  await new Promise(() => {});
}

if (argv[0] === "models") {
  if (Bun.env.NO_COLOR !== "1" || Bun.env.FORCE_COLOR !== "0") {
    console.error("missing NO_COLOR/FORCE_COLOR for models discovery");
    process.exit(1);
  }
  for (const name of ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"]) {
    if (Bun.env[name] !== undefined) {
      console.error(`${name} leaked into agy models`);
      process.exit(1);
    }
  }
  // The real CLI prints its progress line on stderr, never on stdout.
  console.error("Fetching available models...");
  const exitCode = Number(Bun.env.COFORGE_ANTIGRAVITY_MODELS_EXIT ?? "0");
  if (exitCode !== 0) process.exit(exitCode);
  process.stdout.write(
    Bun.env.COFORGE_ANTIGRAVITY_MODELS_OUTPUT ??
      (await Bun.file(new URL("./antigravity-models.txt", import.meta.url)).text()),
  );
  process.exit(0);
}

console.error(`unexpected antigravity models fixture arguments: ${argv.join(" ")}`);
process.exit(2);
