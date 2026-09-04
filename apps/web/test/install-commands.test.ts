import { expect, test } from "bun:test";

import { installCommands } from "@/features/install/install-commands";

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
