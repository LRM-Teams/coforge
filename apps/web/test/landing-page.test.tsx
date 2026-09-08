import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LandingPage, repositoryUrl } from "@/features/landing/landing-page";
import { overwriteGetLocale } from "@/paraglide/runtime";

const installOrigin = "https://staging.coforge.cn";

test("offers a sign-in action that starts the browser login", () => {
  const markup = renderToStaticMarkup(<LandingPage installOrigin={installOrigin} />);

  expect(markup).toContain('href="/auth/login"');
  expect(markup).toContain("Get started");
});

test("keeps installation commands and copy controls off the first screen", () => {
  const markup = renderToStaticMarkup(<LandingPage installOrigin={installOrigin} />);
  const firstScreen = markup.match(/<main\b[^>]*>[\s\S]*?<\/main>/)?.[0];

  expect(firstScreen).toBeDefined();
  expect(firstScreen).not.toContain("curl -fsSL");
  expect(firstScreen).not.toContain("install.ps1");
  expect(firstScreen).not.toContain("coforge-computer setup");
  expect(markup).not.toContain("Copy install command");
  expect(markup).toContain('href="/auth/login"');
});

test("retains the second-screen terminal demonstration", () => {
  const markup = renderToStaticMarkup(<LandingPage installOrigin={installOrigin} />);

  expect(markup).toContain('aria-label="Computer setup demo"');
  expect(markup).toContain("coforge-computer installed");
  expect(markup).toContain("Connected to workspace acme");
});

test("links to the public repository", () => {
  const markup = renderToStaticMarkup(<LandingPage installOrigin={installOrigin} />);

  expect(repositoryUrl).toBe("https://github.com/LRM-Teams/coforge");
  expect(markup).toContain(`href="${repositoryUrl}"`);
  expect(markup).toContain('rel="noreferrer"');
});

test("renders the Simplified Chinese landing catalog", () => {
  overwriteGetLocale(() => "zh-CN");
  const markup = renderToStaticMarkup(<LandingPage installOrigin={installOrigin} />);
  overwriteGetLocale(() => "en");

  expect(markup).toContain("开始使用");
  expect(markup).toContain("GitHub 仓库");
});
