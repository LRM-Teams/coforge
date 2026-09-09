import { expect, mock, test } from "bun:test";
import plugin from "../scripts/oxlint-plugin.js";

test("native-title rule allows official Tooltip title props but rejects DOM title attributes", () => {
  const report = mock(() => {});
  const visitor = plugin.rules["no-native-title"].create({ report });
  const attribute = (name) => ({
    name: { type: "JSXIdentifier", name: "title" },
    parent: { name: { type: "JSXIdentifier", name } },
  });
  visitor.JSXAttribute(attribute("Tooltip"));
  expect(report).not.toHaveBeenCalled();
  visitor.JSXAttribute(attribute("button"));
  expect(report).toHaveBeenCalledTimes(1);
  visitor.JSXAttribute(attribute("span"));
  expect(report).toHaveBeenCalledTimes(2);
});
