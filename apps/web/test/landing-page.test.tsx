import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LandingPage, repositoryUrl } from "@/features/landing/landing-page";
import { overwriteGetLocale } from "@/paraglide/runtime";

test("offers a sign-in action that starts the browser login", () => {
  const markup = renderToStaticMarkup(<LandingPage />);

  expect(markup).toContain('href="/auth/login"');
  expect(markup).toContain("Get started");
});

test("keeps installation commands and copy controls off the public homepage", () => {
  const markup = renderToStaticMarkup(<LandingPage />);

  expect(markup).not.toContain("curl -fsSL");
  expect(markup).not.toContain("install.ps1");
  expect(markup).not.toContain("coforge-computer setup");
  expect(markup).not.toContain("Copy install command");
  expect(markup).toContain('href="/auth/login"');
});

test("links to the public repository", () => {
  const markup = renderToStaticMarkup(<LandingPage />);

  expect(repositoryUrl).toBe("https://github.com/LRM-Teams/coforge");
  expect(markup).toContain(`href="${repositoryUrl}"`);
  expect(markup).toContain('rel="noreferrer"');
});

test("renders the Simplified Chinese landing catalog", () => {
  overwriteGetLocale(() => "zh-CN");
  const markup = renderToStaticMarkup(<LandingPage />);
  overwriteGetLocale(() => "en");

  expect(markup).toContain("开始使用");
  expect(markup).toContain("GitHub 仓库");
});
