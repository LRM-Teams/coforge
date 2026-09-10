import "./dom-setup";

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RuntimeUsage } from "@/features/computers/runtime-usage";
import { baseLocale, overwriteGetLocale } from "@/paraglide/runtime";

afterEach(() => {
  cleanup();
  // Paraglide's locale is process-wide, so a test that switches it has to hand
  // it back even when it fails part-way.
  overwriteGetLocale(() => baseLocale);
});

const codex = {
  provider: "codex" as const,
  version: "1",
  displayName: "Custom Codex",
};

test("Claude offers an explicit first scan without requiring a previous observation", async () => {
  const user = userEvent.setup();
  let scans = 0;
  render(
    <RuntimeUsage
      runtime={{ provider: "claude-code", version: "2", displayName: "Claude Code" }}
      onScan={() => {
        scans += 1;
      }}
    />,
  );
  const page = within(document.body);
  await user.click(page.getByRole("button", { name: "Claude Code · Usage" }));
  const dialog = await page.findByRole("dialog");
  expect(within(dialog).getByText("No snapshot yet")).toBeTruthy();
  expect(scans).toBe(0);
  await user.click(within(dialog).getByRole("button", { name: "Scan" }));
  await waitFor(() => expect(scans).toBe(1));
});

test("keyboard users can open usage, reach Scan, and dismiss it with Escape", async () => {
  const user = userEvent.setup();
  render(<RuntimeUsage runtime={codex} onScan={() => undefined} />);
  const page = within(document.body);
  await user.tab();
  await user.keyboard("{Enter}");
  const dialog = await page.findByRole("dialog");
  await waitFor(() =>
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Scan" })),
  );
  await user.keyboard("{Enter}");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(page.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(page.getByRole("button", { name: /Custom Codex/ }));
});

test("usage scan is on demand and renders a real snapshot", async () => {
  let scans = 0;
  render(
    <RuntimeUsage
      runtime={codex}
      usage={{
        status: "available",
        snapshot: {
          planType: "pro",
          primary: { usedPercent: 42, resetsAt: "2026-09-01T00:00:00Z" },
        },
      }}
      onScan={async () => {
        scans += 1;
      }}
    />,
  );
  const page = within(document.body);

  expect(page.queryByRole("progressbar")).toBeNull();
  expect(page.queryByRole("button", { name: "Refresh" })).toBeNull();
  expect(scans).toBe(0);
  fireEvent.click(page.getByRole("button", { name: /Custom Codex/ }));
  await page.findByRole("dialog");
  expect(document.body.textContent).toContain("Pro");
  expect(document.body.textContent).toContain("Session");
  expect(document.body.textContent).toContain("42% used");
  expect(page.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");

  fireEvent.click(page.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(scans).toBe(1));
});

test("reads as Chinese rather than English word order in the Chinese catalog", async () => {
  overwriteGetLocale(() => "zh-CN");
  render(
    <RuntimeUsage
      runtime={{ ...codex, provider: "kiro" }}
      usage={{
        status: "available",
        snapshot: {
          planType: "pro",
          primary: { usedPercent: 42, resetsAt: "2026-09-01T00:00:00Z" },
        },
      }}
      onScan={() => undefined}
    />,
  );

  fireEvent.click(within(document.body).getByRole("button", { name: /Custom Codex/ }));
  await within(document.body).findByRole("dialog");
  expect(document.body.textContent).toContain("已使用 42%");
  expect(document.body.textContent).not.toContain("42% 已使用");
  expect(document.body.textContent).toContain("Pro 套餐");
  expect(within(document.body).getByText(codex.version)).toBeTruthy();
  expect(document.body.textContent).toContain("每月额度");
  expect(document.body.textContent).toContain("重置于");
});

test("Claude observations support keyboard refresh without inventing a percentage", async () => {
  const user = userEvent.setup();
  let scans = 0;
  render(
    <RuntimeUsage
      runtime={{
        provider: "claude-code",
        version: "1",
        displayName: "Claude Code",
      }}
      usage={{
        status: "available",
        snapshot: {
          primary: {
            status: "rate-limited",
            resetsAt: "2026-09-04T03:00:00.000Z",
          },
        },
      }}
      onScan={() => {
        scans += 1;
      }}
    />,
  );

  const page = within(document.body);
  await user.tab();
  await user.keyboard("{Enter}");
  const dialog = await page.findByRole("dialog");
  expect(document.body.textContent).toContain("Limit reached");
  expect(document.body.textContent).not.toContain("% used");
  expect(page.queryByRole("progressbar")).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Refresh" })),
  );
  expect(scans).toBe(0);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(scans).toBe(1));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(page.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(page.getByRole("button", { name: /Claude Code/ }));
});

test("names the runtime and offers a first scan when there is no snapshot", async () => {
  render(
    <RuntimeUsage
      runtime={{ provider: "codex", version: "1", displayName: "Future Agent" }}
      onScan={() => undefined}
    />,
  );

  expect(document.body.textContent).toContain("Future Agent");
  expect(document.body.textContent).not.toContain("No snapshot yet");
  fireEvent.click(within(document.body).getByRole("button", { name: /Future Agent/ }));
  await within(document.body).findByRole("dialog");
  expect(document.body.textContent).toContain("No snapshot yet");
  expect(within(document.body).getByRole("button", { name: "Scan" })).toBeTruthy();
});

test("Kiro offers an explicit first usage scan", async () => {
  const user = userEvent.setup();
  let scans = 0;
  render(
    <RuntimeUsage
      runtime={{ provider: "kiro", version: "1", displayName: "Kiro" }}
      onScan={() => {
        scans += 1;
      }}
    />,
  );

  const page = within(document.body);
  await user.click(page.getByRole("button", { name: "Kiro · Usage" }));
  const dialog = await page.findByRole("dialog");
  expect(within(dialog).getByText("No snapshot yet")).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Scan" }));
  await waitFor(() => expect(scans).toBe(1));
});

test("Kiro presents its primary quota as monthly included credits", async () => {
  render(
    <RuntimeUsage
      runtime={{ provider: "kiro", version: "1", displayName: "Kiro" }}
      usage={{
        status: "available",
        snapshot: {
          planType: "pro",
          creditUsage: { used: 74, limit: 200, overage: 2.5 },
          primary: { usedPercent: 37, resetsAt: "2026-10-01T00:00:00Z" },
        },
      }}
      onScan={() => undefined}
    />,
  );

  fireEvent.click(within(document.body).getByRole("button", { name: "Kiro · Usage" }));
  const dialog = await within(document.body).findByRole("dialog");
  expect(within(dialog).getByText("Monthly credits")).toBeTruthy();
  expect(within(dialog).getByText("74 / 200 credits used")).toBeTruthy();
  expect(within(dialog).getByText("Overage: 2.5 credits")).toBeTruthy();
  expect(within(dialog).getByText("37% used")).toBeTruthy();
  expect(within(dialog).getByRole("progressbar", { name: "Monthly credits" })).toBeTruthy();
  expect(within(dialog).queryByText("Session")).toBeNull();
  expect(within(dialog).queryByText("Weekly")).toBeNull();
});

test.each(["pi", "coforge"] as const)("%s has no usage controls before any scan", (provider) => {
  render(
    <RuntimeUsage
      runtime={{ provider, displayName: provider, version: "1.2.3" }}
      onScan={() => {
        throw new Error("unsupported runtime must not scan");
      }}
    />,
  );
  const page = within(document.body);
  expect(page.getByText(provider)).toBeTruthy();
  expect(page.getByText("1.2.3")).toBeTruthy();
  expect(page.queryByRole("button")).toBeNull();
  expect(page.queryByRole("dialog")).toBeNull();
});

test.each(["pi", "coforge"] as const)(
  "%s stays non-interactive even if supplied a usage snapshot",
  async (provider) => {
    const user = userEvent.setup();
    render(
      <RuntimeUsage
        runtime={{ provider, displayName: provider, version: "1.2.3" }}
        usage={{
          status: "available",
          snapshot: { primary: { usedPercent: 42, resetsAt: "2026-09-10T03:00:00Z" } },
        }}
        onScan={() => {
          throw new Error("unsupported runtime must not scan");
        }}
      />,
    );
    const page = within(document.body);
    await user.tab();
    expect(document.activeElement).toBe(document.body);
    await user.hover(page.getByText(provider));
    await user.click(page.getByText(provider));
    expect(document.activeElement).toBe(document.body);
    expect(page.queryByRole("button")).toBeNull();
    expect(page.queryByRole("dialog")).toBeNull();
  },
);

test("does not offer or describe usage when the Code Agent does not support it", () => {
  let scans = 0;
  render(
    <RuntimeUsage
      runtime={codex}
      usage={{ status: "unsupported" }}
      onScan={() => {
        scans += 1;
      }}
    />,
  );

  expect(document.body.textContent).toContain("Custom Codex");
  expect(within(document.body).getByText(codex.version)).toBeTruthy();
  expect(document.body.textContent).not.toContain("Usage");
  expect(within(document.body).queryByRole("button")).toBeNull();
  expect(within(document.body).queryByRole("button", { name: /Scan|Refresh/ })).toBeNull();
  expect(scans).toBe(0);
});

test("usage failures never render provider exception messages", async () => {
  render(
    <RuntimeUsage
      runtime={{ provider: "codex", version: "1", displayName: "Codex" }}
      usage={{ status: "error", message: "token secret at 127.0.0.1" }}
      onScan={() => undefined}
    />,
  );
  fireEvent.click(within(document.body).getByRole("button", { name: /Codex/ }));
  await waitFor(() => {
    const text = document.body.textContent;
    expect(text).toContain("Usage scan failed. Try again.");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("127.0.0.1");
  });
});

test("usage failures use the Simplified Chinese catalog", async () => {
  overwriteGetLocale(() => "zh-CN");
  render(
    <RuntimeUsage
      runtime={{ provider: "codex", version: "1", displayName: "Codex" }}
      usage={{ status: "error" }}
      onScan={() => undefined}
    />,
  );
  fireEvent.click(within(document.body).getByRole("button", { name: /Codex/ }));
  await waitFor(() => {
    expect(document.body.textContent).toContain("用量扫描失败，请重试。");
  });
});
