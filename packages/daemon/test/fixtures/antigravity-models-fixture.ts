/**
 * Stand-in for agy's non-turn commands: `agy models` and `agy -p /usage --output-format json`. A
 * fresh process per invocation, argv-driven, no stdin. The default outputs are the real 1.2.13
 * captures in `antigravity-models.txt` and `antigravity-usage.json`; `COFORGE_ANTIGRAVITY_*` env
 * vars replace them or fail the command, and `hang-models` keeps the process alive so the reader's
 * own timeout is what ends it.
 */
const argv = process.argv.slice(2);

for (const name of ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"]) {
  if (Bun.env[name] !== undefined) {
    console.error(`${name} leaked into agy`);
    process.exit(1);
  }
}

if (argv.join(" ") === "-p /usage --output-format json") {
  process.stdout.write(
    Bun.env.COFORGE_ANTIGRAVITY_USAGE_OUTPUT ??
      (await Bun.file(new URL("./antigravity-usage.json", import.meta.url)).text()),
  );
  process.exit(Number(Bun.env.COFORGE_ANTIGRAVITY_USAGE_EXIT ?? "0"));
}

if (argv[0] === "hang-models") {
  await new Promise(() => {});
}

if (argv[0] === "models") {
  if (Bun.env.NO_COLOR !== "1" || Bun.env.FORCE_COLOR !== "0") {
    console.error("missing NO_COLOR/FORCE_COLOR for models discovery");
    process.exit(1);
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
