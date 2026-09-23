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
    expect(people.items.map((person) => person.name)).toEqual([usernames[1]]);
    const morePeople = await members.peoplePage(workspace.id, viewer!.id, {
      query: "",
      limit: 1,
      cursor: people.nextCursor!,
    });
    expect(morePeople.items.map((person) => person.name)).toEqual([usernames[0]]);
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
