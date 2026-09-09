import { z } from "zod";
import type { PrismaClient } from "../../../generated/client";

export const computerObservationSchema = z.object({
  computerVersion: z.string().trim().max(200).optional(),
  platform: z.enum(["", "darwin", "linux", "win32"]).optional(),
  osVersion: z.string().trim().max(200).optional(),
  startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export type ComputerObservation = z.infer<typeof computerObservationSchema>;

export async function recordComputerObservation(
  db: PrismaClient,
  scope: { workspaceId: string; computerId: string },
  observation: ComputerObservation,
) {
  // Missing fields from older executables must not erase previously observed data.
  const data = {
    ...(observation.computerVersion ? { computerVersion: observation.computerVersion } : {}),
    ...(observation.platform ? { platform: observation.platform } : {}),
    ...(observation.osVersion ? { osVersion: observation.osVersion } : {}),
  };
  if (!Object.keys(data).length) return;
  const startedAt = BigInt(observation.startedAt);
  await db.computer.updateMany({
    where: {
      id: scope.computerId,
      workspaces: { some: { workspaceId: scope.workspaceId } },
      OR: [{ metadataStartedAt: null }, { metadataStartedAt: { lte: startedAt } }],
    },
    data: { ...data, metadataStartedAt: startedAt },
  });
}
