import "./dom-setup";

import { expect, test } from "bun:test";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";

import { LandingPage, repositoryUrl } from "@/features/landing/landing-page";
import { overwriteGetLocale } from "@/paraglide/runtime";

const installOrigin = "https://staging.coforge.cn";

test("both account actions start the unified browser authentication flow", () => {
  const page = render(<LandingPage installOrigin={installOrigin} />);

  expect(page.getByRole("link", { name: "Log in" }).getAttribute("href")).toBe("/auth/login");
  expect(page.getByRole("link", { name: "Sign up" }).getAttribute("href")).toBe("/auth/login");
});

test("opens the language menu by pointer and keyboard with the correct locale links", async () => {
  const user = userEvent.setup({ document });
  const page = render(<LandingPage installOrigin={installOrigin} />);
  const trigger = page.getByRole("button", { name: "Language" });

  expect(page.queryByRole("menu")).toBeNull();
  await user.click(trigger);
  const english = page.getByRole("menuitem", { name: "Switch to English" });
  const chinese = page.getByRole("menuitem", { name: "切换到中文" });
  expect(english.getAttribute("href")).toBe("/en");
  expect(english.getAttribute("aria-current")).toBe("true");
  expect(chinese.getAttribute("href")).toBe("/zh-CN");
  expect(chinese.hasAttribute("aria-current")).toBe(false);

  await user.keyboard("{Escape}");
  await waitFor(() => expect(page.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{ArrowDown}");
  await waitFor(() =>
    expect(document.activeElement).toBe(page.getByRole("menuitem", { name: "Switch to English" })),
  );
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(page.getByRole("menuitem", { name: "切换到中文" }));
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

  expect(markup).toContain(">登录</span>");
  expect(markup).toContain(">注册</span>");
  expect(markup).toContain("GitHub 仓库");
});
