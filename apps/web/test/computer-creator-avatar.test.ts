import { expect, test } from "bun:test";
import { handleComputerCreatorAvatar } from "../src/server/computers/computer-creator-avatar.server";
import { AppError } from "../src/lib/app-error";

const computerId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const request = new Request(
  `https://coforge.test/api/computers/${computerId}/creator-avatar?workspaceId=${workspaceId}`,
);

test("serves original creator avatar, not viewer, only through a member-visible Computer", async () => {
  const response = await handleComputerCreatorAvatar(request, computerId, {
    authenticate: () => ({ id: "viewer" }),
    database: () =>
      ({
        workspaceComputer: {
          findFirst: async (query: unknown) => {
            expect(query).toEqual({
              where: {
                workspaceId,
                computerId,
                workspace: { members: { some: { userId: "viewer" } } },
              },
              select: { computer: { select: { ownerId: true } } },
            });
            return { computer: { ownerId: "creator" } };
          },
        },
      }) as never,
    read: async (_db, userId) => {
      expect(userId).toBe("creator");
      return { body: new Blob(["image"]), contentType: "image/png" };
    },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("image");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});

test("denies unauthenticated, inaccessible and malformed creator-avatar requests before reading bytes", async () => {
  const dependencies = {
    authenticate: () => ({ id: "viewer" }),
    database: () => ({ workspaceComputer: { findFirst: async () => null } }) as never,
    read: async () => {
      throw new Error("must not read avatar");
    },
  };
  expect((await handleComputerCreatorAvatar(request, computerId, dependencies)).status).toBe(404);
  expect((await handleComputerCreatorAvatar(request, "invalid", dependencies)).status).toBe(400);
  expect(
    (
      await handleComputerCreatorAvatar(request, computerId, {
        ...dependencies,
        authenticate: () => {
          throw new AppError("ACCESS_DENIED");
        },
      })
    ).status,
  ).toBe(403);
});
