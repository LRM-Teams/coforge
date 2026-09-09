import "./dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ComputerDetail } from "@/features/computers/computer-detail";

afterEach(() => {
  cleanup();
});

const computer = {
  id: "computer-1",
  name: "franks-macbook-pro",
  displayName: "Frank’s MacBook Pro",
  machineId: "macos:9f2c",
  kind: "local",
  ownedByCurrentUser: true,
  online: true,
  connectedAt: "2026-08-31T10:00:00.000Z",
  runtimes: [
    {
      id: "runtime-1",
      provider: "codex" as const,
      displayName: "Codex Runtime",
      version: "0.151.0",
      observedAt: "2026-08-31T10:00:00.000Z",
      isPublic: false,
    },
  ],
  modelCatalogs: [
    {
      provider: "codex",
      models: [{ id: "gpt-5", displayName: "GPT-5", recommended: true }],
    },
  ],
};

test("overview shows observed metadata and original creator while offline", () => {
  render(
    <ComputerDetail
      computer={{
        ...computer,
        online: false,
        ownedByCurrentUser: false,
        computerVersion: "4.5.6",
        platform: "darwin",
        osVersion: "26.1",
        creator: {
          displayName: "Alice Creator",
          username: "alice",
          avatarUrl: "/api/computers/computer-1/creator-avatar?workspaceId=w",
        },
      }}
      onScanUsage={async () => {}}
      onSetRuntimePublic={async () => {}}
    />,
  );
  const page = within(document.body);
  expect(page.getByText("Computer Version")).toBeTruthy();
  expect(page.getByText("4.5.6")).toBeTruthy();
  expect(page.getByText("macOS 26.1")).toBeTruthy();
  expect(page.getByText("Alice Creator")).toBeTruthy();
  expect(page.getByText("@alice")).toBeTruthy();
  expect(document.querySelector("img")?.getAttribute("src")).toBe(
    "/api/computers/computer-1/creator-avatar?workspaceId=w",
  );
  expect(page.getByText("Offline")).toBeTruthy();
});

test("legacy Computers show unknown metadata rather than inferring it from runtimes", () => {
  render(
    <ComputerDetail
      computer={computer}
      onScanUsage={async () => {}}
      onSetRuntimePublic={async () => {}}
    />,
  );
  expect(within(document.body).getAllByText("Unknown")).toHaveLength(3);
});

test("shows the machine and Code Agents with usage hidden until requested", async () => {
  render(
    <ComputerDetail
      computer={computer}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={async () => undefined}
    />,
  );
  const page = within(document.body);

  expect(page.getByRole("heading", { name: "Frank’s MacBook Pro" })).toBeTruthy();
  expect(page.getByText("Online")).toBeTruthy();
  expect(page.getByText("franks-macbook-pro")).toBeTruthy();
  expect(document.body.textContent).not.toContain("macos:9f2c");
  expect(page.getByText("Codex Runtime")).toBeTruthy();
  expect(document.body.textContent).toContain("Version 0.151.0");
  expect(page.queryByText("Models")).toBeNull();
  expect(page.queryByText("GPT-5")).toBeNull();
  expect(page.queryByText("Recommended")).toBeNull();
  expect(page.getByRole("heading", { name: "Detected Runtimes" })).toBeTruthy();
  expect(page.queryByText("No snapshot yet")).toBeNull();
  fireEvent.click(page.getByRole("button", { name: "Codex Runtime · Usage" }));
  await page.findByRole("dialog");
  expect(page.getByText("No snapshot yet")).toBeTruthy();
});

test("lets the Computer owner edit its display name from the overview", async () => {
  const updateDisplayName = mock(async (_displayName: string) => undefined);
  const user = userEvent.setup();
  render(
    <ComputerDetail
      computer={computer}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={async () => undefined}
      onUpdateDisplayName={updateDisplayName}
    />,
  );

  const page = within(document.body);
  await user.click(page.getByRole("button", { name: "Edit display name" }));
  const input = page.getByRole("textbox", { name: "Display name" });
  await user.clear(input);
  await user.type(input, "Frank’s Studio Mac");
  await user.click(page.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(updateDisplayName).toHaveBeenCalledWith("Frank’s Studio Mac"));
  expect(page.queryByRole("textbox", { name: "Display name" })).toBeNull();
});

test("does not offer display-name editing for a shared Computer", () => {
  render(
    <ComputerDetail
      computer={{ ...computer, ownedByCurrentUser: false }}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={async () => undefined}
      onUpdateDisplayName={async () => undefined}
    />,
  );

  expect(within(document.body).queryByRole("button", { name: "Edit display name" })).toBeNull();
});

test("labels publication acceptance as waiting for actual restart recovery", async () => {
  const restart = mock(async (requestId: string) => ({
    requestId,
    status: "accepted" as const,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  render(
    <ComputerDetail
      computer={computer}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={async () => undefined}
      onRestart={restart}
    />,
  );

  fireEvent.click(within(document.body).getByRole("button", { name: "Restart" }));
  await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  expect((await within(document.body).findByRole("status")).textContent).toContain(
    "this is not completion yet",
  );
});

test("shows the recovered daemon version and process identity after restart", async () => {
  render(
    <ComputerDetail
      computer={computer}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={async () => undefined}
      onRestart={async (requestId) => ({
        requestId,
        status: "accepted",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })}
      onReadRestartStatus={async (requestId) => ({
        requestId,
        status: "completed",
        completedAt: new Date().toISOString(),
        workerInstanceId: "worker-new",
        daemonVersion: "2.3.4",
        startedAt: 2,
      })}
      restartPollIntervalMs={1}
    />,
  );
  fireEvent.click(within(document.body).getByRole("button", { name: "Restart" }));
  await waitFor(() =>
    expect(within(document.body).getByRole("status").textContent).toContain(
      "Daemon 2.3.4, process worker-new",
    ),
  );
});

test("shows a bounded restart timeout as an error", async () => {
  render(
    <ComputerDetail
      computer={computer}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={async () => undefined}
      onRestart={async (requestId) => ({
        requestId,
        status: "accepted",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })}
      onReadRestartStatus={async (requestId) => ({
        requestId,
        status: "accepted",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })}
      restartPollIntervalMs={1}
      restartMaxPolls={1}
    />,
  );
  fireEvent.click(within(document.body).getByRole("button", { name: "Restart" }));
  expect((await within(document.body).findByRole("alert")).textContent).toContain(
    "did not complete before the deadline",
  );
});

test("scans usage for the runtime the User asked about", async () => {
  const scanned: string[] = [];
  render(
    <ComputerDetail
      computer={computer}
      onScanUsage={async (provider) => {
        scanned.push(provider);
      }}
      onSetRuntimePublic={async () => undefined}
    />,
  );

  fireEvent.click(within(document.body).getByRole("button", { name: "Codex Runtime · Usage" }));
  fireEvent.click(await within(document.body).findByRole("button", { name: "Scan" }));
  await waitFor(() => expect(scanned).toEqual(["codex"]));
});

test("allows the Computer owner to publish a private runtime", async () => {
  const setPublic = mock(async () => undefined);
  render(
    <ComputerDetail
      computer={computer}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={setPublic}
    />,
  );

  fireEvent.click(
    within(document.body).getByRole("button", {
      name: "Publish Codex Runtime",
    }),
  );
  await waitFor(() => expect(setPublic).toHaveBeenCalledWith("runtime-1", true));
});

test("keeps runtime visibility unchanged, reports failures inline, and prevents duplicate updates", async () => {
  let rejectUpdate: ((reason?: unknown) => void) | undefined;
  const setPublic = mock(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectUpdate = reject;
      }),
  );
  render(
    <ComputerDetail
      computer={computer}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={setPublic}
    />,
  );
  const publish = within(document.body).getByRole("button", {
    name: "Publish Codex Runtime",
  });

  fireEvent.click(publish);
  fireEvent.click(publish);
  expect(setPublic).toHaveBeenCalledTimes(1);
  expect(publish.getAttribute("aria-pressed")).toBe("false");

  rejectUpdate?.(new Error("unavailable"));
  const alert = await within(document.body).findByRole("alert");
  expect(alert.textContent).toContain("Runtime visibility could not be changed");
  expect(publish.getAttribute("aria-pressed")).toBe("false");
  await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
});

test("tracks concurrent runtime visibility updates and failures independently", async () => {
  const runtimeAFirst = Promise.withResolvers<void>();
  const runtimeARetry = Promise.withResolvers<void>();
  const runtimeB = Promise.withResolvers<void>();
  let runtimeAAttempts = 0;
  const setPublic = mock((runtimeId: string) => {
    if (runtimeId === "runtime-1") {
      runtimeAAttempts += 1;
      return runtimeAAttempts === 1 ? runtimeAFirst.promise : runtimeARetry.promise;
    }
    return runtimeB.promise;
  });
  render(
    <ComputerDetail
      computer={{
        ...computer,
        runtimes: [
          computer.runtimes[0]!,
          {
            id: "runtime-2",
            provider: "claude-code" as const,
            displayName: "Claude Runtime",
            version: "1.0.0",
            isPublic: false,
          },
        ],
      }}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={setPublic}
    />,
  );
  const page = within(document.body);
  const publishA = page.getByRole("button", { name: "Publish Codex Runtime" });
  const publishB = page.getByRole("button", { name: "Publish Claude Runtime" });
  const runtimeA = within(publishA.closest("li")!);

  fireEvent.click(publishA);
  fireEvent.click(publishB);
  expect(publishA.hasAttribute("disabled")).toBe(true);
  expect(publishB.hasAttribute("disabled")).toBe(true);

  runtimeAFirst.reject(new Error("unavailable"));
  expect((await runtimeA.findByRole("alert")).textContent).toContain(
    "Runtime visibility could not be changed",
  );
  expect(publishB.hasAttribute("disabled")).toBe(true);

  runtimeB.resolve();
  await waitFor(() => expect(publishB.hasAttribute("disabled")).toBe(false));
  expect(runtimeA.getByRole("alert")).toBeTruthy();

  fireEvent.click(publishA);
  await waitFor(() => expect(runtimeA.queryByRole("alert")).toBeNull());
  expect(publishA.hasAttribute("disabled")).toBe(true);
  runtimeARetry.resolve();
  await waitFor(() => expect(publishA.hasAttribute("disabled")).toBe(false));
});

test("does not expose owner-only runtime controls on a shared Computer", () => {
  render(
    <ComputerDetail
      computer={{
        ...computer,
        ownedByCurrentUser: false,
        runtimes: [{ ...computer.runtimes[0]!, isPublic: true }],
      }}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={async () => undefined}
    />,
  );

  const page = within(document.body);
  expect(page.getByText("Codex Runtime")).toBeTruthy();
  expect(page.queryByRole("button", { name: "Scan" })).toBeNull();
  expect(page.queryByRole("button", { name: /private/i })).toBeNull();
});
