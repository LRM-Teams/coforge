import "./dom-setup";

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import { RuntimeUsage } from "@/features/computers/runtime-usage";
import { baseLocale, overwriteGetLocale } from "@/paraglide/runtime";

afterEach(() => {
  cleanup();
  // Paraglide's locale is process-wide, so a test that switches it has to hand
  // it back even when it fails part-way.
  overwriteGetLocale(() => baseLocale);
});

const codex = { provider: "codex" as const, version: "1", displayName: "Custom Codex" };

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

  expect(document.body.textContent).toContain("Pro");
  expect(document.body.textContent).toContain("Session");
  expect(document.body.textContent).toContain("42% used");
  expect(page.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");

  fireEvent.click(page.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(scans).toBe(1));
});

test("reads as Chinese rather than English word order in the Chinese catalog", () => {
  overwriteGetLocale(() => "zh-CN");
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
      onScan={() => undefined}
    />,
  );

  expect(document.body.textContent).toContain("已使用 42%");
  expect(document.body.textContent).not.toContain("42% 已使用");
  expect(document.body.textContent).toContain("Pro 套餐");
  expect(document.body.textContent).toContain("版本 1");
  expect(document.body.textContent).toContain("重置于");
});

test("renders a Claude rate-limit observation without inventing a percentage", () => {
  render(
    <RuntimeUsage
      runtime={{ provider: "claude-code", version: "1", displayName: "Claude Code" }}
      usage={{
        status: "available",
        snapshot: { primary: { status: "rate-limited", resetsAt: "2026-09-04T03:00:00.000Z" } },
      }}
      onScan={() => undefined}
    />,
  );

  expect(document.body.textContent).toContain("Limit reached");
  expect(document.body.textContent).not.toContain("% used");
  expect(within(document.body).queryByRole("progressbar")).toBeNull();
});

test("names the runtime and offers a first scan when there is no snapshot", () => {
  render(
    <RuntimeUsage
      runtime={{ provider: "codex", version: "1", displayName: "Future Agent" }}
      onScan={() => undefined}
    />,
  );

  expect(document.body.textContent).toContain("Future Agent");
  expect(document.body.textContent).toContain("No snapshot yet");
  expect(within(document.body).getByRole("button", { name: "Scan" })).toBeTruthy();
});

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
  expect(document.body.textContent).toContain("Version 1");
  expect(document.body.textContent).not.toContain("Usage");
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
  await waitFor(() => {
    expect(document.body.textContent).toContain("用量扫描失败，请重试。");
  });
});
