import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LoginPage } from "@/components/login-page";
import { overwriteGetLocale } from "@/paraglide/runtime";

test("shows the Authing sign-in action", () => {
  const markup = renderToStaticMarkup(<LoginPage />);

  expect(markup).toContain("Sign in to CoForge");
  expect(markup).toContain("Continue");
  expect(markup).toContain('href="/auth/login"');
  expect(markup).not.toContain("Sign-in failed");
});

test("shows a failed sign-in alert", () => {
  const markup = renderToStaticMarkup(<LoginPage error="invalid login state" />);
  expect(markup).toContain('role="alert"');
  expect(markup).toContain("Sign-in failed. Try again.");
});

test("renders the Simplified Chinese login catalog", () => {
  overwriteGetLocale(() => "zh-CN");
  const markup = renderToStaticMarkup(<LoginPage />);
  overwriteGetLocale(() => "en");

  expect(markup).toContain("登录 CoForge");
  expect(markup).toContain("继续");
});
