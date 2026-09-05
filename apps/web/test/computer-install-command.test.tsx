import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ComputerInstallCommand } from "@/features/computers/computer-install-command";
import { overwriteGetLocale } from "@/paraglide/runtime";

const installOrigin = "https://staging.coforge.cn";

test("renders both the install command and the Workspace setup command", () => {
  const markup = renderToStaticMarkup(
    <ComputerInstallCommand installOrigin={installOrigin} workspaceSlug="acme-inc" />,
  );

  expect(markup).toContain("curl -fsSL https://staging.coforge.cn/computer/install.sh | sh");
  expect(markup).toContain("coforge-computer setup --workspace acme-inc");
});

test("names the current Workspace in the setup step's description", () => {
  const markup = renderToStaticMarkup(
    <ComputerInstallCommand installOrigin={installOrigin} workspaceSlug="acme-inc" />,
  );

  expect(markup).toContain("acme-inc");
});

test("omits the setup command when no Workspace slug is available", () => {
  const markup = renderToStaticMarkup(
    <ComputerInstallCommand installOrigin={installOrigin} workspaceSlug={null} />,
  );

  expect(markup).toContain("curl -fsSL https://staging.coforge.cn/computer/install.sh | sh");
  expect(markup).not.toContain("coforge-computer setup");
});

test("renders the Simplified Chinese setup step catalog", () => {
  overwriteGetLocale(() => "zh-CN");
  const markup = renderToStaticMarkup(
    <ComputerInstallCommand installOrigin={installOrigin} workspaceSlug="acme-inc" />,
  );
  overwriteGetLocale(() => "en");

  expect(markup).toContain("加入此工作区");
  expect(markup).toContain("coforge-computer setup --workspace acme-inc");
});
