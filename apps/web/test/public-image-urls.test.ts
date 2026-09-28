import { expect, test } from "bun:test";

import { computerCreatorAvatarUrl } from "#src/server/computers/computer-creator-avatar.server";
import {
  createPublicImageDelivery,
  type ProfileImageStyle,
} from "#src/server/files/public-image-delivery.server";
import {
  avatarUrl,
  workspaceUserAvatarUrl,
} from "#src/server/db/repositories/user-profile.repositories.server";
import { projectIconUrl } from "#src/server/projects/project-images.server";

const delivery = createPublicImageDelivery({ baseUrl: "https://images-staging.coforge.cn" });
const publicImageUrl = (objectKey: string, style: ProfileImageStyle) =>
  delivery?.url(objectKey, style) ?? null;
const noDelivery = () => null;

const avatarKey = "users/user-1/avatars/avatar-1/original";
const iconKey = "workspaces/workspace-1/projects/project-1/icons/icon-1/original";

test("an unset image gives no URL at all", () => {
  expect(avatarUrl(null, publicImageUrl)).toBeNull();
  expect(workspaceUserAvatarUrl("workspace-1", "user-1", null, publicImageUrl)).toBeNull();
  expect(projectIconUrl("project-1", null, publicImageUrl)).toBeNull();
  expect(computerCreatorAvatarUrl("computer-1", "workspace-1", null, publicImageUrl)).toBeNull();
});

test("configured delivery addresses every profile image on the image CDN at a bounded size", () => {
  const expected = `https://images-staging.coforge.cn/${avatarKey}?x-oss-process=style/avatar192`;
  expect(avatarUrl(avatarKey, publicImageUrl)).toBe(expected);
  expect(workspaceUserAvatarUrl("workspace-1", "user-1", avatarKey, publicImageUrl)).toBe(expected);
  expect(computerCreatorAvatarUrl("computer-1", "workspace-1", avatarKey, publicImageUrl)).toBe(
    expected,
  );
  expect(projectIconUrl("project-1", iconKey, publicImageUrl)).toBe(
    `https://images-staging.coforge.cn/${iconKey}?x-oss-process=style/icon256`,
  );
});

test("the same object key always yields the same URL, so the browser caches one copy", () => {
  expect(avatarUrl(avatarKey, publicImageUrl)).toBe(
    workspaceUserAvatarUrl("workspace-1", "user-1", avatarKey, publicImageUrl),
  );
});

test("without delivery every image falls back to its authenticated route", () => {
  expect(avatarUrl(avatarKey, noDelivery)).toBe("/api/me/avatar?v=avatar-1");
  expect(workspaceUserAvatarUrl("workspace-1", "user-1", avatarKey, noDelivery)).toBe(
    "/api/workspaces/workspace-1/users/user-1/avatar?v=avatar-1",
  );
  expect(projectIconUrl("project-1", iconKey, noDelivery)).toBe(
    "/api/projects/project-1/icon?v=icon-1",
  );
  expect(computerCreatorAvatarUrl("computer-1", "workspace-1", avatarKey, noDelivery)).toBe(
    "/api/computers/computer-1/creator-avatar?workspaceId=workspace-1",
  );
});
