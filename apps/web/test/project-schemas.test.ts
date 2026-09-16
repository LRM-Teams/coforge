import { expect, test } from "bun:test";
import {
  projectIconUploadInput,
  updateProjectInput,
} from "../src/features/projects/projects.schemas";

const update = {
  id: "b445d915-bced-446a-815c-6c7e2fb57242",
  name: "Launch",
  description: "Release planning",
};

test("project metadata leaves image and omitted repository changes absent", () => {
  const unchanged = updateProjectInput.parse(update);
  expect(unchanged).not.toHaveProperty("icon");
  expect(unchanged).not.toHaveProperty("repository");
  expect(updateProjectInput.parse({ ...update, repository: null }).repository).toBeNull();
});

test("project image upload requires a real file and a valid project identity", () => {
  const data = new FormData();
  data.set("id", update.id);
  expect(projectIconUploadInput.safeParse(data).success).toBeFalse();
  data.set("file", "https://example.com/icon.png");
  expect(projectIconUploadInput.safeParse(data).success).toBeFalse();
  data.set("file", new File(["image bytes"], "icon.png", { type: "image/png" }));
  expect(projectIconUploadInput.parse(data).file.type).toBe("image/png");
  data.set("id", "invalid");
  expect(projectIconUploadInput.safeParse(data).success).toBeFalse();
});
