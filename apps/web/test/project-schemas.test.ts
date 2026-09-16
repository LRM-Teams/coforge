import { expect, test } from "bun:test";
import { updateProjectInput } from "../src/features/projects/projects.schemas";

const update = {
  id: "b445d915-bced-446a-815c-6c7e2fb57242",
  name: "Launch",
  description: "Release planning",
};

test("project settings accepts supported icons and leaves omitted changes absent", () => {
  expect(updateProjectInput.parse({ ...update, icon: "🚀" }).icon).toBe("🚀");
  expect(updateProjectInput.parse({ ...update, icon: "⚙️" }).icon).toBe("⚙️");
  const unchanged = updateProjectInput.parse(update);
  expect(unchanged).not.toHaveProperty("icon");
  expect(unchanged).not.toHaveProperty("repository");
  expect(updateProjectInput.parse({ ...update, repository: null }).repository).toBeNull();
});

test("project settings rejects arbitrary icon text, URLs, null and unlisted emoji", () => {
  for (const icon of ["", "rocket", "https://example.com/icon.png", "<svg/>", "🚀🚀", "🐉", null]) {
    expect(updateProjectInput.safeParse({ ...update, icon }).success).toBeFalse();
  }
});
