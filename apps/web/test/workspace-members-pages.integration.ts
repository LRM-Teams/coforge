import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { WorkspaceMembers } from "#src/server/workspaces/members.server";

test("pages the Workspace directory with owner and search filters", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const usernames = ["viewer", "owner", "outsider"].map((name) => `pages-${name}-${suffix}`);
  try {
    const [viewer, owner, outsider] = await Promise.all(
      usernames.map((username, index) =>
        db.user.create({
          data: { username, displayName: ["Viewer", "Owner", "Outsider"][index] },
        }),
      ),
    );
    const workspace = await db.workspace.create({
      data: {
        slug: `pages-${suffix}`,
        name: "Paged directory",
        members: { create: [{ userId: viewer!.id }, { userId: owner!.id }] },
      },
    });
    const computer = await db.computer.create({
      data: {
        ownerId: owner!.id,
        machineId: `pages-${suffix}`,
        name: "build-host",
        displayName: "Build Mac",
      },
    });
    await db.workspaceComputer.create({
      data: { workspaceId: workspace.id, computerId: computer.id },
    });
    // Five Agents: alpha..echo. The viewer owns alpha and bravo; charlie and delta run on the
    // Computer; echo has no Computer.
    const specs = [
      { name: "alpha", ownerId: viewer!.id, computerId: computer.id },
      { name: "bravo", ownerId: viewer!.id, computerId: null },
      { name: "charlie", ownerId: owner!.id, computerId: computer.id },
      { name: "delta", ownerId: owner!.id, computerId: computer.id },
      { name: "echo", ownerId: owner!.id, computerId: null },
    ] as { name: string; ownerId: string; computerId: string | null }[];
    // Privacy and scoping: another member's private Agent on a Computer no visible Agent
    // uses, and an Agent whose Computer belongs only to another Workspace.
    const hiddenHost = await db.computer.create({
      data: { ownerId: owner!.id, machineId: `pages-hidden-${suffix}`, name: "secret-host" },
    });
    await db.workspaceComputer.create({
      data: { workspaceId: workspace.id, computerId: hiddenHost.id },
    });
    await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner!.id,
        computerId: hiddenHost.id,
        name: "hidden",
        displayName: "Hidden",
        visibility: "private",
        runtimeConfig: {},
      },
    });
    const detachedHost = await db.computer.create({
      data: { ownerId: owner!.id, machineId: `pages-detached-${suffix}`, name: "elsewhere-host" },
    });
    specs.push({ name: "foxtrot", ownerId: owner!.id, computerId: detachedHost.id });
    for (const spec of specs) {
      await db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: spec.ownerId,
          computerId: spec.computerId,
          name: spec.name,
          displayName: spec.name.toUpperCase(),
          runtimeConfig: {},
        },
      });
    }

    const members = new WorkspaceMembers(db);
    const names = (page: { items: { name: string }[] }) => page.items.map((agent) => agent.name);
    const all = { owner: "all", query: "" } as const;

    expect(await members.summary(workspace.id, viewer!.id)).toEqual({
      workspaceId: workspace.id,
      actorRole: "member",
      viewerId: viewer!.id,
      agentCount: 6,
      peopleCount: 2,
    });

    const first = await members.agentPage(workspace.id, viewer!.id, { ...all, limit: 2 });
    expect(names(first)).toEqual(["alpha", "bravo"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await members.agentPage(workspace.id, viewer!.id, {
      ...all,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(names(second)).toEqual(["charlie", "delta"]);
    const last = await members.agentPage(workspace.id, viewer!.id, {
      ...all,
      limit: 3,
      cursor: second.nextCursor!,
    });
    expect(names(last)).toEqual(["echo", "foxtrot"]);
    expect(last.nextCursor).toBeNull();

    const page = (filters: { owner?: "all" | "mine"; query?: string }) =>
      members.agentPage(workspace.id, viewer!.id, { ...all, ...filters, limit: 24 });
    expect(names(await page({ owner: "mine" }))).toEqual(["alpha", "bravo"]);
    expect(names(await page({ query: "elsewhere" }))).toEqual([]);
    expect(names(await page({ query: "hidden" }))).toEqual([]);
    expect(names(await page({ query: "secret" }))).toEqual([]);
    // Search matches the handle, the display name and the Computer name, case-insensitively.
    expect(names(await page({ query: "ARL" }))).toEqual(["charlie"]);
    expect(names(await page({ query: "build mac" }))).toEqual(["alpha", "charlie", "delta"]);
    expect(names(await page({ query: "nobody" }))).toEqual([]);

    const people = await members.peoplePage(workspace.id, viewer!.id, { query: "", limit: 1 });
    expect(people.items.map((person) => person.displayName)).toEqual(["Owner"]);
    const morePeople = await members.peoplePage(workspace.id, viewer!.id, {
      query: "",
      limit: 1,
      cursor: people.nextCursor!,
    });
    expect(morePeople.items.map((person) => person.displayName)).toEqual(["Viewer"]);
    expect(morePeople.nextCursor).toBeNull();
    expect(
      (await members.peoplePage(workspace.id, viewer!.id, { query: "VIEW", limit: 24 })).items,
    ).toHaveLength(1);

    await expect(members.summary(workspace.id, outsider!.id)).rejects.toThrow("ACCESS_DENIED");
    await expect(
      members.agentPage(workspace.id, outsider!.id, { ...all, limit: 24 }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      members.peoplePage(workspace.id, outsider!.id, { query: "", limit: 24 }),
    ).rejects.toThrow("ACCESS_DENIED");
  } finally {
    await db.workspace.deleteMany({ where: { slug: `pages-${suffix}` } });
    await db.computer.deleteMany({
      where: {
        machineId: {
          in: [`pages-${suffix}`, `pages-hidden-${suffix}`, `pages-detached-${suffix}`],
        },
      },
    });
    await db.user.deleteMany({ where: { username: { in: usernames } } });
    await db.$disconnect();
  }
});

test("each person carries the Agents they created that the viewer can see", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const usernames = ["viewer", "creator"].map((name) => `created-${name}-${suffix}`);
  const slugs = [`created-${suffix}`, `created-other-${suffix}`];
  try {
    const [viewer, creator] = await Promise.all(
      usernames.map((username) => db.user.create({ data: { username } })),
    );
    const [workspace, otherWorkspace] = await Promise.all(
      slugs.map((slug) =>
        db.workspace.create({
          data: {
            slug,
            name: slug,
            members: { create: [{ userId: viewer!.id }, { userId: creator!.id }] },
          },
        }),
      ),
    );
    const agent = (name: string, extra: object = {}) =>
      db.agent.create({
        data: {
          workspaceId: workspace!.id,
          ownerId: creator!.id,
          name,
          displayName: name.toUpperCase(),
          runtimeConfig: {},
          ...extra,
        },
      });
    // Six public Agents, created out of name order; a private one the viewer may not see,
    // a deleted one, and one in another Workspace are not counted.
    for (const name of ["foxtrot", "alpha", "echo", "charlie", "bravo", "delta"]) await agent(name);
    await agent("hidden", { visibility: "private" });
    await agent("gone", { deletedAt: new Date() });
    await db.agent.create({
      data: {
        workspaceId: otherWorkspace!.id,
        ownerId: creator!.id,
        name: "elsewhere",
        displayName: "Elsewhere",
        runtimeConfig: {},
      },
    });

    const people = await new WorkspaceMembers(db).peoplePage(workspace!.id, viewer!.id, {
      query: "",
      limit: 24,
    });
    // These people have no names of their own, so each is shown by its username.
    const byName = new Map(people.items.map((person) => [person.displayName, person]));
    const created = byName.get(usernames[1]!)!.createdAgents;
    expect(created.total).toBe(6);
    // The card shows a few faces and a "+N" for the rest, in the directory's name order.
    expect(created.items.map((item) => item.displayName)).toEqual([
      "ALPHA",
      "BRAVO",
      "CHARLIE",
      "DELTA",
    ]);
    expect(byName.get(usernames[0]!)!.createdAgents).toEqual({ total: 0, items: [] });
  } finally {
    await db.workspace.deleteMany({ where: { slug: { in: slugs } } });
    await db.user.deleteMany({ where: { username: { in: usernames } } });
    await db.$disconnect();
  }
});

test("people search reads the name a person is shown by, never a username they did not choose", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const uid = crypto.randomUUID().slice(0, 8);
  const usernames = [`ada-${uid}`, `grace-${uid}`, `legacy-${uid}`];
  try {
    const [ada, grace, legacy] = await Promise.all([
      db.user.create({
        data: { username: usernames[0]!, displayName: "Countess", fullName: "Ada Lovelace" },
      }),
      db.user.create({ data: { username: usernames[1]!, fullName: "Grace Hopper" } }),
      // Never asked for a name: their username is the label everyone sees.
      db.user.create({ data: { username: usernames[2]! } }),
    ]);
    const workspace = await db.workspace.create({
      data: {
        slug: `search-${uid}`,
        name: "People search",
        members: { create: [ada!, grace!, legacy!].map((user) => ({ userId: user.id })) },
      },
    });
    const search = async (query: string) =>
      (
        await new WorkspaceMembers(db).peoplePage(workspace.id, ada!.id, { query, limit: 24 })
      ).items.map((person) => person.displayName);

    expect(await search("countess")).toEqual(["Countess"]);
    // The nickname replaced the full name on screen, and the full name still finds them.
    expect(await search("ada lovelace")).toEqual(["Countess"]);
    expect(await search("HOPPER")).toEqual(["Grace Hopper"]);
    // A person with no name is shown by, and found by, their username.
    expect(await search(`legacy-${uid}`)).toEqual([`legacy-${uid}`]);
    // A username nobody sees does not find a person who has a name.
    expect(await search(`ada-${uid}`)).toEqual([]);
    expect(await search(`grace-${uid}`)).toEqual([]);
  } finally {
    await db.workspace.deleteMany({ where: { slug: `search-${uid}` } });
    await db.user.deleteMany({ where: { username: { in: usernames } } });
    await db.$disconnect();
  }
});

test("people are paged in the order of the names they are shown by, not of their usernames", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const uid = crypto.randomUUID().slice(0, 8);
  // Their usernames sort z, a, m, b, c, t2, t1; the names shown sort differently.
  const specs = [
    { username: `pg-z-${uid}`, fullName: "Ada Lovelace" },
    { username: `pg-a-${uid}`, displayName: "bea", fullName: "Zed Zimmer" },
    { username: `pg-m-${uid}`, fullName: "Cyd Charisse" },
    // A blank display name is no name: the full name is shown.
    { username: `pg-b-${uid}`, displayName: "  ", fullName: "Bob Barker" },
    // No names at all: the username is the label.
    { username: `pg-c-${uid}` },
    // Two people shown alike are told apart by username.
    { username: `pg-t2-${uid}`, fullName: "Sam Same" },
    { username: `pg-t1-${uid}`, fullName: "Sam Same" },
  ];
  const usernames = specs.map((spec) => spec.username);
  try {
    const users = await Promise.all(specs.map((data) => db.user.create({ data })));
    const workspace = await db.workspace.create({
      data: {
        slug: `people-order-${uid}`,
        name: "People order",
        members: { create: users.map((user) => ({ userId: user.id })) },
      },
    });
    const members = new WorkspaceMembers(db);
    const viewerId = users[0]!.id;
    /** Every page of a search, walked by cursor, as the names shown. */
    const walk = async (query: string, limit: number) => {
      const shown: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await members.peoplePage(workspace.id, viewerId, { query, limit, cursor });
        shown.push(...page.items.map((person) => person.displayName));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return shown;
    };

    const inOrder = [
      "Ada Lovelace",
      "bea",
      "Bob Barker",
      "Cyd Charisse",
      `pg-c-${uid}`,
      "Sam Same",
      "Sam Same",
    ];
    expect(await walk("", 24)).toEqual(inOrder);
    // The same order whatever the page size, so a cursor resumes exactly where it stopped, even
    // between two people shown alike.
    expect(await walk("", 1)).toEqual(inOrder);
    expect(await walk("", 3)).toEqual(inOrder);
    const sams = await members.peoplePage(workspace.id, viewerId, { query: "sam", limit: 1 });
    const secondSam = await members.peoplePage(workspace.id, viewerId, {
      query: "sam",
      limit: 1,
      cursor: sams.nextCursor!,
    });
    expect([sams.items[0]!.id, secondSam.items[0]!.id]).toEqual([users[6]!.id, users[5]!.id]);
    expect(secondSam.nextCursor).toBeNull();
  } finally {
    await db.workspace.deleteMany({ where: { slug: `people-order-${uid}` } });
    await db.user.deleteMany({ where: { username: { in: usernames } } });
    await db.$disconnect();
  }
});
