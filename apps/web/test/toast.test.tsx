import "./dom-setup";

import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { AppToastProvider, useAppToast } from "@/components/ui/toast";
import { AppError } from "@/lib/app-error";

afterEach(async () => {
  act(() => {
    toast.dismiss();
  });
  await waitFor(() => {
    if (document.querySelector("[data-sonner-toast]")) throw new Error("Toasts are still closing");
  });
  cleanup();
});

function ToastDemo() {
  const toast = useAppToast();
  return (
    <div>
      <button type="button" onClick={() => toast.success("Profile saved.")}>
        Success
      </button>
      <button type="button" onClick={() => toast.error("Could not save")}>
        Error
      </button>
      <button
        type="button"
        onClick={() =>
          toast.error("Could not save", new AppError("INTERNAL_ERROR", { errorId: "sample-ref" }))
        }
      >
        Error with reference
      </button>
    </div>
  );
}

test("toast position follows the workbench mobile breakpoint", async () => {
  const originalWidth = window.innerWidth;
  try {
    for (const [width, vertical, horizontal] of [
      [767, "top", "center"],
      [768, "bottom", "right"],
    ] as const) {
      window.innerWidth = width;
      const view = render(
        <AppToastProvider>
          <ToastDemo />
        </AppToastProvider>,
      );
      await userEvent.setup({ document }).click(view.getByRole("button", { name: "Success" }));
      const stack = view.getByRole("region", { name: "Notifications" }).querySelector("ol");
      expect(stack?.getAttribute("data-y-position")).toBe(vertical);
      expect(stack?.getAttribute("data-x-position")).toBe(horizontal);
      act(() => {
        toast.dismiss();
      });
      view.unmount();
    }
  } finally {
    window.innerWidth = originalWidth;
  }
});

test("renders shared success feedback and deduplicates matching toasts", async () => {
  const user = userEvent.setup({ document });
  const view = render(
    <AppToastProvider>
      <ToastDemo />
    </AppToastProvider>,
  );

  await user.click(view.getByRole("button", { name: "Success" }));
  await user.click(view.getByRole("button", { name: "Success" }));

  expect(view.getAllByText("Profile saved.")).toHaveLength(1);
  expect(view.getByText("Profile saved.").closest("[data-type='success']")).toBeTruthy();
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Success" }));
  await user.click(view.getByRole("button", { name: "Error" }));
  expect(view.getByRole("region", { name: "Notifications" }).textContent).toContain(
    "Could not save",
  );
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Error" }));
});

test("error updates keep only the current safe reference without a close button", async () => {
  const user = userEvent.setup({ document });
  const view = render(
    <AppToastProvider>
      <ToastDemo />
    </AppToastProvider>,
  );
  await user.click(view.getByRole("button", { name: "Error with reference" }));
  const notifications = within(view.getByRole("region", { name: "Notifications" }));
  expect(notifications.getByText(/sample-ref/)).toBeTruthy();
  expect(notifications.queryByText(/COFORGE_APP_ERROR/)).toBeNull();
  await user.click(view.getByRole("button", { name: "Error" }));
  expect(notifications.getAllByText("Could not save")).toHaveLength(1);
  expect(notifications.queryByText(/sample-ref/)).toBeNull();
  expect(notifications.queryByRole("button")).toBeNull();
});
