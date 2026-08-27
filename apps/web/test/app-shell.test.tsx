import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AppShell } from "@/components/app-shell";
import { overwriteGetLocale } from "@/paraglide/runtime";

test("shows the primary navigation with Members selected", () => {
  const markup = renderToStaticMarkup(<AppShell />);

  expect(markup).toContain("<aside");
  expect(markup).toContain("Overview");
  expect(markup).toContain("Search");
  expect(markup).toContain("Notifications");
  expect(markup).toContain("Conversations");
  expect(markup).toContain("Projects");
  expect(markup).toContain("Members");
  expect(markup).toContain("Computers");
  expect(markup).toContain('aria-label="Current user"');
  expect(markup).toContain('aria-current="page"');
});

test("shows the member workspace header and main content", () => {
  const markup = renderToStaticMarkup(<AppShell />);

  expect(markup).toContain("<header");
  expect(markup).toContain("<main");
  expect(markup).toContain("Agents");
  expect(markup).toContain("Collaborators");
  expect(markup).toContain("Agent overview");
  expect(markup).toContain("New agent");
  expect(markup).toContain("Archived agents");
  expect(markup).toContain("Search agents");
  expect(markup).toContain("Atlas");
  expect(markup).toContain("Product designer");
  expect(markup.match(/data-agent-card/g)?.length).toBe(6);
});

test("renders the same shell from the Simplified Chinese catalog", () => {
  overwriteGetLocale(() => "zh-CN");
  const markup = renderToStaticMarkup(<AppShell />);
  overwriteGetLocale(() => "en");

  expect(markup).toContain("成员");
  expect(markup).toContain("智能体汇总");
  expect(markup).toContain("新建智能体");
});
