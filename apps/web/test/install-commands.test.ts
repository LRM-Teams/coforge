import { expect, test } from "bun:test";

import { installCommands, setupCommand } from "@/features/install/install-commands";

/** Both the public landing page and the signed-in Add Computer dialog render from this, so a
 * host baked into either one would send half the users to the wrong deployment. */
test("roots both bootstrap commands at the given deployment", () => {
  const commands = installCommands("https://staging.coforge.cn");

  expect(commands.posix).toBe("curl -fsSL https://staging.coforge.cn/computer/install.sh | sh");
  expect(commands.windows).toBe("irm https://staging.coforge.cn/computer/install.ps1 | iex");
});

test("carries no fixed host of its own", () => {
  const commands = installCommands("http://localhost:8788");

  expect(`${commands.posix} ${commands.windows}`).not.toContain("coforge.cn");
});

/** The two-command install flow's second step: the same shape the Computer CLI's `setup`
 * subcommand accepts, so the command copied out of the dialog just works. */
test("builds the Workspace setup command for a given slug", () => {
  expect(setupCommand("acme-inc")).toBe("coforge-computer setup --workspace acme-inc");
});

test("carries no fixed host, since the setup command runs against whatever server the Computer already logged into", () => {
  expect(setupCommand("acme-inc")).not.toContain("coforge.cn");
  expect(setupCommand("acme-inc")).not.toContain("http");
});
