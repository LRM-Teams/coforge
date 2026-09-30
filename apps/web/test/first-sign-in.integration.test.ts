import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { completeFirstSignIn, readNameStep } from "#src/server/auth/first-sign-in.server";
import { workspaceIdForUser } from "#src/server/workspaces/enrollment.server";

/**
 * First sign-in's name step and the personal Workspace it makes, against local PostgreSQL: the
 * name is saved and titles the Workspace, however many times or from however many tabs it is
 * submitted, exactly one Workspace is made, and the person is its owner in `#general`.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({ data: { username: `fsi-${suffix}` } });
  const memberships = () =>
    db.workspaceMembership.findMany({
      where: { userId: user.id },
      include: { workspace: true },
    });
  const teardown = async () => {
    const owned = await memberships();
    await db.workspace
      .deleteMany({ where: { id: { in: owned.map((row) => row.workspaceId) } } })
      .catch(() => {});
    await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  };
  return { db, user, memberships, teardown };
}

test.skipIf(!connectionString)(
  "submitting a full name saves it and makes an owned Workspace titled with it",
  async () => {
    const { db, user, memberships, teardown } = await setup();
    try {
      expect(await readNameStep({ db, user: { id: user.id, name: "Provider Ada" } })).toEqual({
        status: "ask",
        prefill: "Provider Ada",
      });

      const result = await completeFirstSignIn({
        db,
        user,
        fullName: "  Ada   Lovelace ",
        acceptLanguage: "en-US",
      });

      expect(result.ok).toBe(true);
      const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(stored.fullName).toBe("Ada Lovelace");
      const [membership, ...others] = await memberships();
      expect(others).toEqual([]);
      expect(membership?.role).toBe("owner");
      expect(membership?.workspace.name).toBe("Ada Lovelace's Workspace");
      expect(
        await db.conversationMember.count({
          where: { userId: user.id, conversation: { channelName: "general" }, leftAt: null },
        }),
      ).toBe(1);
      expect(await readNameStep({ db, user: { id: user.id, name: "" } })).toEqual({
        status: "named",
      });
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a session whose user row is gone is told to sign in again, not asked",
  async () => {
    const { db, user, teardown } = await setup();
    try {
      const gone = crypto.randomUUID();
      expect(await readNameStep({ db, user: { id: gone, name: "Ada" } })).toEqual({
        status: "account_gone",
      });
      expect(await readNameStep({ db, user: { id: user.id, name: "Ada" } })).toEqual({
        status: "ask",
        prefill: "Ada",
      });
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a name that is not accepted saves nothing and makes no Workspace",
  async () => {
    const { db, user, memberships, teardown } = await setup();
    try {
      const result = await completeFirstSignIn({
        db,
        user,
        fullName: "System",
        acceptLanguage: "en",
      });

      expect(result).toEqual({ ok: false, problem: "refused" });
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).fullName).toBeNull();
      expect(await memberships()).toEqual([]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "the same person submitting from several tabs at once ends with one Workspace and the first name",
  async () => {
    const { db, user, memberships, teardown } = await setup();
    try {
      const results = await Promise.all(
        ["Ada Lovelace", "Ada Lovelace", "Ada King", "Countess Lovelace", "Ada Lovelace"].map(
          (fullName) => completeFirstSignIn({ db, user, fullName, acceptLanguage: "en" }),
        ),
      );

      const workspaceIds = new Set(results.map((result) => (result.ok ? result.workspaceId : "")));
      expect(workspaceIds.size).toBe(1);
      expect(workspaceIds.has("")).toBe(false);
      const rows = await memberships();
      expect(rows).toHaveLength(1);
      // Whichever tab was first, its name is the stored one and it titles the Workspace.
      const stored = (await db.user.findUniqueOrThrow({ where: { id: user.id } })).fullName;
      expect(rows[0]?.workspace.name).toBe(`${stored}'s Workspace`);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "two sign-in callbacks enrolling the same new person at once make one Workspace",
  async () => {
    const { db, user, memberships, teardown } = await setup();
    try {
      const enrolling = { id: user.id, username: user.username, fullName: "Ada Lovelace" };
      const ids = await Promise.all(
        Array.from({ length: 5 }, () => workspaceIdForUser(db, enrolling, "en")),
      );

      expect(new Set(ids).size).toBe(1);
      expect(await memberships()).toHaveLength(1);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "someone who already has a Workspace is named without a second one",
  async () => {
    const { db, user, memberships, teardown } = await setup();
    try {
      const existing = await workspaceIdForUser(
        db,
        { id: user.id, username: user.username, fullName: "Earlier Name" },
        "en",
      );

      const result = await completeFirstSignIn({
        db,
        user,
        fullName: "Ada Lovelace",
        acceptLanguage: "en",
      });

      expect(result).toEqual({ ok: true, workspaceId: existing });
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).fullName).toBe(
        "Ada Lovelace",
      );
      expect(await memberships()).toHaveLength(1);
    } finally {
      await teardown();
    }
  },
);
