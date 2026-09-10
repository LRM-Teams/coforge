// Static markup needs no DOM, but Base UI decides once per process whether it
// is running in a browser. Evaluating it here without happy-dom registered
// leaves every later test file unable to open a portal.
import "./dom-setup";

import { expect, test } from "bun:test";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Heading, Text } from "react-aria-components";
import { User01, XClose } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";

test("renders the official Button with an Untitled UI icon", () => {
  const markup = renderToStaticMarkup(<Button iconLeading={User01}>Start</Button>);

  expect(markup).toContain("<button");
  expect(markup).toContain("<svg");
  expect(markup).toContain("Start");
});

test("opens a tooltip when its trigger receives keyboard focus", async () => {
  const user = userEvent.setup({ document });
  const page = render(
    <Tooltip title="Helpful detail">
      <TooltipTrigger aria-label="More information">Info</TooltipTrigger>
    </Tooltip>,
  );

  expect(page.queryByRole("tooltip")).toBeNull();
  await user.tab();
  expect(document.activeElement).toBe(page.getByRole("button", { name: "More information" }));
  expect((await page.findByRole("tooltip")).textContent).toBe("Helpful detail");
});

test("a controlled dialog opens and closes via its close button", async () => {
  const user = userEvent.setup({ document });

  function ControlledDialog() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button onPress={() => setOpen(true)}>Open dialog</Button>
        <ModalOverlay isOpen={open} onOpenChange={setOpen}>
          <Modal className="w-96">
            <Dialog className="p-6">
              {({ close }) => (
                <>
                  <ButtonUtility
                    aria-label="Close dialog"
                    icon={XClose}
                    size="sm"
                    color="tertiary"
                    onClick={close}
                  />
                  <Heading slot="title">Edit draft</Heading>
                  <Text slot="description">Draft details</Text>
                  <input aria-label="Draft" defaultValue="" />
                </>
              )}
            </Dialog>
          </Modal>
        </ModalOverlay>
      </>
    );
  }

  render(<ControlledDialog />);
  const page = within(document.body);
  expect(page.getByRole("textbox", { name: "Draft" })).toBeTruthy();
  await user.click(page.getByRole("button", { name: "Close dialog" }));
  expect(page.queryByRole("textbox", { name: "Draft" })).toBeNull();
  await user.click(page.getByRole("button", { name: "Open dialog" }));
  expect(page.getByRole<HTMLInputElement>("textbox", { name: "Draft" }).value).toBe("");
});
