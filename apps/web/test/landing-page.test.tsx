import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LandingPage, repositoryUrl } from "@/features/landing/landing-page";
import { overwriteGetLocale } from "@/paraglide/runtime";

const installScriptUrl = "https://staging.coforge.cn/computer/install.sh";

test("offers a sign-in action that starts the browser login", () => {
  const markup = renderToStaticMarkup(<LandingPage installScriptUrl={installScriptUrl} />);

  expect(markup).toContain('href="/auth/login"');
  expect(markup).toContain("Sign in");
});

test("links to the public repository", () => {
  const markup = renderToStaticMarkup(<LandingPage installScriptUrl={installScriptUrl} />);

  expect(repositoryUrl).toBe("https://github.com/LRM-Teams/coforge");
  expect(markup).toContain(`href="${repositoryUrl}"`);
  expect(markup).toContain('rel="noreferrer"');
  expect(markup).toContain("github.com/LRM-Teams/coforge");
});

test("shows the install command of the deployment being visited", () => {
  const markup = renderToStaticMarkup(<LandingPage installScriptUrl={installScriptUrl} />);

  expect(markup).toContain("curl -fsSL https://staging.coforge.cn/computer/install.sh | sh");
});

test("renders the Simplified Chinese landing catalog", () => {
  overwriteGetLocale(() => "zh-CN");
  const markup = renderToStaticMarkup(<LandingPage installScriptUrl={installScriptUrl} />);
  overwriteGetLocale(() => "en");

  expect(markup).toContain("登录");
  expect(markup).toContain("GitHub 仓库");
});
