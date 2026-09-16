import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../generated/client";
import type { GitHubConfig } from "./github-connection.server";

/**
 * Verifies GitHub's `X-Hub-Signature-256` header (`sha256=<hex hmac of the raw body>`)
 * with a timing-safe comparison. Pure and DB-free so it is unit-testable on its own.
 */
export function verifyGitHubWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | null,
): boolean {
  if (!header) return false;
  const prefix = "sha256=";
  if (!header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

const idSchema = z.number().int().positive().safe();
const senderSchema = z.object({ id: idSchema });
const installationRefSchema = z.object({
  id: idSchema,
  app_id: idSchema,
  account: z.object({ login: z.string().min(1).max(100) }),
  repository_selection: z.enum(["all", "selected"]),
  html_url: z.string().url().optional(),
});
const installationEventSchema = z.object({
  action: z.string(),
  installation: installationRefSchema,
  sender: senderSchema.optional(),
});
const installationRepositoriesEventSchema = z.object({
  action: z.string(),
  installation: installationRefSchema,
});
const appAuthorizationEventSchema = z.object({
  action: z.string(),
  sender: senderSchema,
});

function configureUrl(installation: z.infer<typeof installationRefSchema>) {
  return installation.html_url ?? `https://github.com/settings/installations/${installation.id}`;
}

/**
 * Applies one already signature-verified GitHub webhook event to the installation cache.
 * Tolerant of unrecognized events and malformed payloads: both are silent no-ops so the
 * route can always respond 204 (GitHub retries non-2xx responses). Never logs payloads.
 */
export async function applyGitHubWebhookEvent(
  db: PrismaClient,
  config: Pick<GitHubConfig, "appId" | "clientId">,
  event: string,
  payload: unknown,
): Promise<void> {
  switch (event) {
    case "installation": {
      const parsed = installationEventSchema.safeParse(payload);
      if (!parsed.success) return;
      const { action, installation, sender } = parsed.data;
      if (installation.app_id !== config.appId) return;
      if (action === "deleted") {
        await db.gitHubUserInstallation.deleteMany({ where: { installationId: installation.id } });
        return;
      }
      if (action === "suspend" || action === "unsuspend") {
        await db.gitHubUserInstallation.updateMany({
          where: { installationId: installation.id },
          data: { suspended: action === "suspend" },
        });
        return;
      }
      if (action === "created" || action === "new_permissions_accepted") {
        const data = {
          accountLogin: installation.account.login,
          repositorySelection: installation.repository_selection,
          configureUrl: configureUrl(installation),
        };
        await db.gitHubUserInstallation.updateMany({
          where: { installationId: installation.id },
          data,
        });
        // The installer can see their own new installation immediately. Other users
        // sharing the same organization installation pick it up on their next sync.
        if (sender) {
          const connection = await db.gitHubConnection.findUnique({
            where: {
              clientId_githubUserId: {
                clientId: config.clientId,
                githubUserId: String(sender.id),
              },
            },
          });
          if (connection)
            await db.gitHubUserInstallation.upsert({
              where: {
                userId_installationId: {
                  userId: connection.userId,
                  installationId: installation.id,
                },
              },
              create: {
                userId: connection.userId,
                installationId: installation.id,
                suspended: false,
                syncedAt: new Date(),
                ...data,
              },
              update: { suspended: false, syncedAt: new Date(), ...data },
            });
        }
        return;
      }
      return;
    }
    case "installation_repositories": {
      const parsed = installationRepositoriesEventSchema.safeParse(payload);
      if (!parsed.success) return;
      const { installation } = parsed.data;
      if (installation.app_id !== config.appId) return;
      await db.gitHubUserInstallation.updateMany({
        where: { installationId: installation.id },
        data: { repositorySelection: installation.repository_selection },
      });
      return;
    }
    case "github_app_authorization": {
      const parsed = appAuthorizationEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.action !== "revoked") return;
      const connection = await db.gitHubConnection.findUnique({
        where: {
          clientId_githubUserId: {
            clientId: config.clientId,
            githubUserId: String(parsed.data.sender.id),
          },
        },
      });
      if (!connection) return;
      await db.$transaction([
        db.gitHubConnection.update({
          where: { userId: connection.userId },
          data: { credentials: null },
        }),
        db.gitHubUserInstallation.deleteMany({ where: { userId: connection.userId } }),
      ]);
      return;
    }
    default:
      return;
  }
}
