import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";

import { AppShell } from "@/components/app-shell";
import { AgentsContent } from "@/components/agents-content";
import { overwriteGetLocale } from "@/paraglide/runtime";
import { getRouter } from "@/router";

const user = { name: "Frank An", email: "frank@example.com" };

try {
  GlobalRegistrator.register({ url: "http://localhost/en" });
} catch {
  // Another test file may have registered Happy DOM first.
}
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister().catch(() => undefined));

function renderShell() {
  return render(
    <RouterContextProvider router={getRouter()}>
      <AppShell user={user}>
        <AgentsContent />
      </AppShell>
    </RouterContextProvider>,
  ).container.innerHTML;
}

test("shows the primary navigation with Members selected", () => {
  const markup = renderShell();

  expect(markup).toContain("<aside");
  expect(markup).toContain("Members");
  expect(markup).toContain("Computers");
  expect(markup).toContain('aria-label="Current user"');
  expect(markup).toContain(">F</button>");
  expect(markup).toContain('aria-current="page"');
});

test("shows the member workspace header and main content", () => {
  const markup = renderShell();

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
  const markup = renderShell();
  overwriteGetLocale(() => "en");

  expect(markup).toContain("成员");
  expect(markup).toContain("智能体汇总");
  expect(markup).toContain("新建智能体");
});
