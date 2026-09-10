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
  expect(english.getAttribute("data-current")).toBe("true");
  expect(chinese.getAttribute("href")).toBe("/zh-CN");
  expect(chinese.hasAttribute("data-current")).toBe(false);

  await user.keyboard("{Escape}");
  await waitFor(() => expect(page.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  // ArrowDown on the trigger reopens the menu. React Aria moves focus into the
  // portaled menu in a browser, but happy-dom does not observe that move, so the
  // focus target itself is not asserted here (see the workspace-switcher tests).
  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(page.getByRole("menu")).toBeTruthy());
  expect(page.getByRole("menuitem", { name: "Switch to English" })).toBeTruthy();
  expect(page.getByRole("menuitem", { name: "切换到中文" })).toBeTruthy();
});

test("shows the terminal in the single-page hero instead of the description and second screen", () => {
  const markup = renderToStaticMarkup(<LandingPage installOrigin={installOrigin} />);
  const firstScreen = markup.match(/<main\b[^>]*>[\s\S]*?<\/main>/)?.[0];

  expect(firstScreen).toBeDefined();
  expect(firstScreen).toContain('aria-label="Computer setup demo"');
  expect(firstScreen).toContain("coforge-computer installed");
  expect(firstScreen).toContain("Connected to workspace acme");
  expect(markup.match(/aria-label="Computer setup demo"/g)).toHaveLength(1);
  expect(markup).not.toContain("Talk to them like teammates");
  expect(markup).not.toContain("Your computer, your code.");
  expect(markup).not.toContain('href="#computer"');
  expect(markup).not.toContain("<section");
  expect(markup).not.toContain("Copy install command");
  expect(markup).toContain('href="/auth/login"');
});

test("keeps code agent marks inside the terminal rather than around the headline", () => {
  const page = render(<LandingPage installOrigin={installOrigin} />);
  const terminal = page.getByRole("region", { name: "Computer setup demo" });

  expect(page.queryByRole("list", { name: "Works with" })).toBeNull();
  expect(page.queryByText("OpenCode")).toBeNull();
  expect(page.queryByText("Grok")).toBeNull();
  for (const name of ["Claude Code", "Codex", "Pi"]) {
    const label = page.getByText(name, { exact: true });
    expect(terminal.contains(label)).toBe(true);
    expect(label.querySelector("img, [aria-hidden='true']")).not.toBeNull();
  }
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
