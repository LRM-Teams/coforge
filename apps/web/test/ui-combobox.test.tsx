import "./dom-setup";
import { expect, test } from "bun:test";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComboBox } from "@/components/base/select/combobox";
import { SelectItem } from "@/components/base/select/select-item";

test("official ComboBox preserves selection across reordered items and permits a new search", async () => {
  const user = userEvent.setup({ document });
  const options = [
    { id: "Asia/Shanghai", label: "Shanghai" },
    { id: "Asia/Tokyo", label: "Tokyo" },
  ];
  const selections: Array<string | number | null> = [];
  const content = (items: typeof options) => (
    <ComboBox
      aria-label="Time zone"
      shortcut={false}
      items={items}
      onSelectionChange={(key) => selections.push(key)}
    >
      {(item) => <SelectItem id={item.id} label={item.label} />}
    </ComboBox>
  );
  const view = render(content(options));
  const input = view.getByRole("combobox", { name: "Time zone" });
  await user.click(input);
  await user.type(input, "Tokyo");
  expect(view.queryByRole("option", { name: "Shanghai" })).toBeNull();
  await user.click(view.getByRole("option", { name: "Tokyo" }));
  expect(selections.filter((key) => key !== null)).toEqual(["Asia/Tokyo"]);
  view.rerender(content([...options].reverse().map((item) => ({ ...item }))));
  expect((input as HTMLInputElement).value).toBe("Tokyo");
  await user.click(input);
  await user.clear(input);
  await user.type(input, "Shanghai");
  await user.click(view.getByRole("option", { name: "Shanghai" }));
  expect(selections.filter((key) => key !== null)).toEqual(["Asia/Tokyo", "Asia/Shanghai"]);
});
