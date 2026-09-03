// Static markup needs no DOM, but Base UI decides once per process whether it
// is running in a browser. Evaluating it here without happy-dom registered
// leaves every later test file unable to open a portal.
import "./dom-setup";

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Bot } from "lucide-react";

import { Button } from "@/components/ui/button";

test("renders the Base UI button with a Lucide icon", () => {
  const markup = renderToStaticMarkup(
    <Button>
      <Bot aria-hidden="true" />
      Start
    </Button>,
  );

  expect(markup).toContain("<button");
  expect(markup).toContain("<svg");
  expect(markup).toContain("Start");
});
