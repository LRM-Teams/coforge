import { expect, test } from "bun:test";
import {
  createProjectInput,
  projectIconUploadInput,
  updateProjectInput,
} from "../src/features/projects/projects.schemas";

const update = {
  id: "b445d915-bced-446a-815c-6c7e2fb57242",
  name: "Launch",
  description: "Release planning",
  commitCoAuthor: true,
};

test("creating a project accepts a public GitHub full name without an installation", () => {
  expect(
    createProjectInput.parse({ name: "Widgets", slug: "widgets", fullName: "acme/widgets" }),
  ).toEqual({
    name: "Widgets",
    slug: "widgets",
    fullName: "acme/widgets",
  });
  expect(
    createProjectInput.parse({
      name: "Widgets",
      slug: "widgets",
      installationId: 7,
      repositoryId: 42,
      fullName: "acme/widgets",
    }).repositoryId,
  ).toBe(42);
  expect(
    createProjectInput.safeParse({
      name: "Widgets",
      slug: "widgets",
      repositoryId: 42,
      fullName: "acme/widgets",
    }).success,
  ).toBeFalse();
});

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
