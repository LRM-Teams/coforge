import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LandingPage, repositoryUrl } from "@/features/landing/landing-page";
import { overwriteGetLocale } from "@/paraglide/runtime";

test("offers a sign-in action that starts the browser login", () => {
  const markup = renderToStaticMarkup(<LandingPage />);

  expect(markup).toContain('href="/auth/login"');
  expect(markup).toContain("Sign in");
});

test("links to the public repository", () => {
  const markup = renderToStaticMarkup(<LandingPage />);

  expect(repositoryUrl).toBe("https://github.com/LRM-Teams/coforge");
  expect(markup).toContain(`href="${repositoryUrl}"`);
  expect(markup).toContain('rel="noreferrer"');
  expect(markup).toContain("github.com/LRM-Teams/coforge");
});

test("renders the Simplified Chinese landing catalog", () => {
  overwriteGetLocale(() => "zh-CN");
  const markup = renderToStaticMarkup(<LandingPage />);
  overwriteGetLocale(() => "en");

  expect(markup).toContain("登录");
  expect(markup).toContain("GitHub 仓库");
});
