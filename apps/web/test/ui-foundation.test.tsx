// Static markup needs no DOM, but Base UI decides once per process whether it
// is running in a browser. Evaluating it here without happy-dom registered
// leaves every later test file unable to open a portal.
import "./dom-setup";

import { expect, test } from "bun:test";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { User01 } from "@untitledui/icons";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

test("renders the Base UI button with an Untitled UI icon", () => {
  const markup = renderToStaticMarkup(
    <Button>
      <User01 aria-hidden="true" />
      Start
    </Button>,
  );

  expect(markup).toContain("<button");
  expect(markup).toContain("<svg");
  expect(markup).toContain("Start");
});

test("opens a tooltip when its trigger receives keyboard focus", async () => {
  const user = userEvent.setup({ document });
  const page = render(
    <Tooltip>
      <TooltipTrigger aria-label="More information">Info</TooltipTrigger>
      <TooltipContent>Helpful detail</TooltipContent>
    </Tooltip>,
  );

  expect(page.queryByRole("tooltip")).toBeNull();
  await user.tab();
  expect(document.activeElement).toBe(page.getByRole("button", { name: "More information" }));
  expect((await page.findByRole("tooltip")).textContent).toBe("Helpful detail");
});

test("a keep-mounted dialog preserves an uncontrolled draft across close and reopen", async () => {
  const user = userEvent.setup({ document });

  function DraftDialog() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open dialog</button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogPortal keepMounted>
            <DialogPopup>
              <DialogTitle>Edit draft</DialogTitle>
              <input aria-label="Draft" defaultValue="" />
              <DialogClose>Close dialog</DialogClose>
            </DialogPopup>
          </DialogPortal>
        </Dialog>
      </>
    );
  }

  render(<DraftDialog />);
  const page = within(document.body);
  await user.type(page.getByRole("textbox", { name: "Draft" }), "Retained value");
  await user.click(page.getByRole("button", { name: "Close dialog" }));
  expect(page.queryByRole("textbox", { name: "Draft" })).toBeNull();
  await user.click(page.getByRole("button", { name: "Open dialog" }));
  expect(page.getByRole<HTMLInputElement>("textbox", { name: "Draft" }).value).toBe(
    "Retained value",
  );
});
