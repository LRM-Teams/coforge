import "./dom-setup";

import { expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import { ComputerContent } from "@/components/computer-content";

test("runtime row includes persisted metadata and explicit no-snapshot usage state", async () => {
  render(
    <ComputerContent
      computers={[
        {
          id: "computer-1",
          machineId: "machine-1",
          online: true,
          runtimes: [
            {
              provider: "codex",
              displayName: "Codex Runtime",
              version: "0.151.0",
              observedAt: "2026-08-31",
            },
          ],
          modelCatalogs: [{ provider: "codex", models: [{ id: "gpt-5", displayName: "GPT-5" }] }],
        },
      ]}
      onAdd={() => undefined}
    />,
  );

  expect(document.body.textContent).toContain("Codex Runtime");
  expect(document.body.textContent).toContain("0.151.0");
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  fireEvent.click(within(document.body).getByRole("button", { name: /Codex Runtime/ }));
  await waitFor(() => {
    const popover = within(document.body).getByRole("dialog");
    expect(popover.textContent).toContain("No snapshot yet");
  });
  cleanup();
});
